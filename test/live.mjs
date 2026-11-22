/**
 * End-to-end check against a real `dcg` binary.
 *
 * Builds a fake Cordis context, calls the real `arm()`, then pushes tool calls
 * through the listener it registered — so the binary lookup, version gate, doctor
 * probes, generated policy, audit log, and decision mapping all run for real.
 *
 *   node test/live.mjs
 *
 * `DSH_HOME` is redirected to a scratch directory first, so the plugin's real
 * `generated/` and `audit/` never see this run's output. Not part of `npm test`:
 * it needs dcg installed, which the unit tests deliberately do not.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-live-'))
process.env.DSH_HOME = scratch

/**
 * `--no-dcg` hides PATH first, so the gate cannot find a binary and has to run
 * its not-ready branch. Kept as a separate child run because `which()` reads the
 * live process environment.
 */
const NO_DCG = process.argv.includes('--no-dcg')
if (NO_DCG) {
  process.env.PATH = ''
  process.env.Path = ''
}

const { normalizeConfig } = await import('../lib/config.js')
const { arm } = await import('../lib/gate.js')

const WORKSPACE = process.cwd()
const NEXT = Symbol('next')
const logs = []

/** Minimal Cordis context: `on` collects, `effect` runs the generator body. */
function makeCtx() {
  const registered = []
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    on(event, listener, options) {
      const entry = { event, listener, options }
      registered.push(entry)
      return entry
    },
    effect(body) {
      const returned = []
      const iterator = body()
      let step = iterator.next()
      while (step.done !== true) {
        returned.push(step.value)
        step = iterator.next()
      }
      return async () => {
        for (const value of returned) if (typeof value === 'function') await value()
      }
    },
  }
  return { ctx, registered }
}

function call(command, extra = {}) {
  return {
    name: extra.tool ?? 'ops_bash',
    arguments: extra.arguments ?? (command === undefined ? {} : { command }),
    callId: `call-${Math.random().toString(16).slice(2)}`,
    agent: { session: { id: 'live-session', header: { id: 'live-session', cwd: WORKSPACE } } },
  }
}

let failures = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${actual}${ok ? '' : `   (expected ${expected})`}`)
}

/** one `{ arm, listener, dispose }` built from real settings */
function boot(config) {
  const { settings, warnings } = normalizeConfig({ enabled: true, ...config })
  if (warnings.length > 0) {
    failures += 1
    console.log(`FAIL  settings rejected: ${warnings.join('; ')}`)
  }
  const { ctx, registered } = makeCtx()
  const dispose = arm(ctx, settings)
  const entry = registered.find((item) => item.event === 'tools/pre-execute')
  const listener = entry?.listener

  const run = async (exec) => {
    const outcome = await listener(exec, async () => NEXT)
    if (outcome === NEXT) return 'next'
    if (outcome === undefined) return 'next'
    return outcome?.kind ?? `kind=${String(outcome?.kind)}`
  }
  return { settings, listener, run, dispose, registered }
}

/** Child-run mode: no dcg anywhere, so the gate must follow `onNotReady`. */
async function notReadyMode() {
  const strict = boot({})
  check('ls -la (onNotReady=deny) → deny', await strict.run(call('ls -la')), 'deny')
  await strict.dispose()

  const lenient = boot({ onNotReady: 'pass' })
  check('ls -la (onNotReady=pass) → proceed', await lenient.run(call('ls -la')), 'next')
  await lenient.dispose()

  console.log(failures === 0 ? 'not-ready path behaved as expected' : `${failures} check(s) failed`)
  fs.rmSync(scratch, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

async function main() {
  if (NO_DCG) return notReadyMode()

  console.log(`workspace: ${WORKSPACE}`)
  console.log(`DSH_HOME:  ${scratch}`)
  console.log('')

  // --- default settings: what a fresh install actually does -------------------
  const fresh = boot({})
  console.log(`tools:     ${JSON.stringify(fresh.settings.tools)}`)
  console.log(`prepend:   ${String(fresh.registered.find((i) => i.event === 'tools/pre-execute')?.options?.prepend)}`)
  console.log('')
  console.log('-- default settings: defaultMode=ask, onAsk=ask --')
  check('ls -la              → proceed', await fresh.run(call('ls -la')), 'next')
  check('git status          → proceed', await fresh.run(call('git status')), 'next')
  check('rm -rf ./build      → ask', await fresh.run(call('rm -rf ./build')), 'ask')
  check('git reset --hard    → ask', await fresh.run(call('git reset --hard HEAD~1')), 'ask')
  check('unjudged tool       → proceed', await fresh.run(call(undefined, { tool: 'read', arguments: { file_path: 'x' } })), 'next')
  check('no command at all   → proceed', await fresh.run(call(undefined, { arguments: {} })), 'next')
  check('script_path         → deny', await fresh.run(call(undefined, { arguments: { script_path: 'a.sh' } })), 'deny')
  await fresh.dispose()

  // --- a bogus dcgPath is not fatal: PATH is still consulted ------------------
  const fallback = boot({ dcgPath: path.join(scratch, 'nope', 'dcg.exe') })
  console.log('')
  console.log('-- dcgPath points nowhere, PATH still has dcg --')
  check('ls -la              → proceed', await fallback.run(call('ls -la')), 'next')
  check('rm -rf ./build      → ask', await fallback.run(call('rm -rf ./build')), 'ask')
  await fallback.dispose()

  // --- defaultMode: "deny" turns every flagged command into a refusal ---------
  const strict = boot({ policy: { defaultMode: 'deny' } })
  console.log('')
  console.log('-- policy.defaultMode = "deny" --')
  check('rm -rf ./build      → deny', await strict.run(call('rm -rf ./build')), 'deny')
  check('git push --force    → deny', await strict.run(call('git push --force origin main')), 'deny')
  check('ls -la              → proceed', await strict.run(call('ls -la')), 'next')
  await strict.dispose()

  // --- onAsk: "deny" makes the ask path fail closed ---------------------------
  const askAsDeny = boot({ policy: { defaultMode: 'ask' }, onAsk: 'deny' })
  console.log('')
  console.log('-- defaultMode = "ask" with onAsk = "deny" --')
  check('cd /tmp && rm -rf *  → deny', await askAsDeny.run(call('cd /tmp && rm -rf *')), 'deny')
  await askAsDeny.dispose()

  // --- onNotReady: needs a machine with no dcg at all, so a child run does it -
  console.log('')
  console.log('-- gate with no dcg reachable (child run, PATH stripped) --')
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--no-dcg'], { encoding: 'utf8' })
  const childLines = `${child.stdout ?? ''}${child.stderr ?? ''}`.trimEnd().split('\n')
  for (const line of childLines) console.log(`  ${line}`)
  if (child.status !== 0) failures += 1

  // --- disposal stops admitting calls ----------------------------------------
  const closed = boot({})
  await closed.run(call('ls -la'))
  await closed.dispose()
  check('after dispose       → cancel', await closed.run(call('ls -la')), 'cancel')

  // --- what landed on disk ---------------------------------------------------
  console.log('')
  const generated = path.join(scratch, 'dsh-shell-dcg', 'generated', 'policy.toml')
  console.log(`policy file: ${fs.existsSync(generated) ? 'written' : 'MISSING'} (${generated})`)
  if (fs.existsSync(generated)) {
    const text = fs.readFileSync(generated, 'utf8')
    console.log(text.trimEnd().split('\n').map((line) => `  | ${line}`).join('\n'))
  }
  const auditRoot = path.join(scratch, 'dsh-shell-dcg', 'audit')
  const auditFiles = fs.existsSync(auditRoot) ? fs.readdirSync(auditRoot) : []
  console.log(`audit files: ${auditFiles.join(', ') || 'none'}`)
  if (auditFiles.length > 0) {
    const lines = fs
      .readFileSync(path.join(auditRoot, auditFiles[0]), 'utf8')
      .trimEnd()
      .split('\n')
    console.log(`audit lines: ${lines.length}`)
    for (const line of lines.slice(0, 3)) console.log(`  | ${line}`)
  }

  console.log('')
  const errors = logs.filter(([level]) => level === 'error')
  console.log(`log lines: ${logs.length} (errors: ${errors.length})`)
  for (const [level, message] of logs.slice(0, 6)) console.log(`  [${level}] ${message}`)

  console.log('')
  console.log(failures === 0 ? 'live gate behaved as expected' : `${failures} check(s) failed`)
  fs.rmSync(scratch, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

await main()
