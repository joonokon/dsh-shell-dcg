/**
 * Measure what the gate costs per command.
 *
 *   node test/bench.mjs [--runs 100] [--bin dcg]
 *
 * Two numbers matter. The first is one `dcg` call (process start plus its own
 * evaluation), because the gate shells out rather than keeping a resident
 * evaluator. The second is a whole tool call through `arm()`, once with the
 * dialect cross-check off and once with it on — the mode the settings page
 * offers, and the only place the double pass shows up.
 *
 * @module dsh-shell-dcg/test/bench
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeConfig, policyPath } from '../lib/config.js'
import { arm } from '../lib/gate.js'

/** One allowed command, one refused command: the two paths through the gate. */
const CASES = [
  ['allow  ls -la', 'ls -la'],
  ['deny   rm -rf ./build', 'rm -rf ./build'],
  ['deny   git reset --hard', 'git reset --hard HEAD~1'],
]

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const runs = Number.parseInt(option('runs', '100'), 10)
const bin = option('bin', 'dcg')
const policy = policyPath()
const args = ['--robot', 'test', '--stdin', '--format', 'json', '--dialect', 'posix', '--config', policy]

/** Min / median / p90 / max of one sample set, in milliseconds. */
function summarise(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]
  return { min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] }
}

console.log(`bin      ${bin}`)
console.log(`policy   ${policy}`)
console.log(`host     ${os.cpus()[0].model.trim()} / ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB / ${os.platform()} ${os.release()}`)
console.log(`node     ${process.version}`)
console.log('')
console.log('one dcg call                  n      min   median      p90      max')

for (const [label, command] of CASES) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint()
    const result = spawnSync(bin, args, { input: command, encoding: 'utf8', timeout: 20_000 })
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (result.error !== undefined) {
      console.error(`\n${label}: ${result.error.message}`)
      process.exit(1)
    }
  }
  const stats = summarise(samples)
  console.log(
    `${label.padEnd(26)} ${String(runs).padStart(4)}  ${stats.min.toFixed(1).padStart(6)}  ${stats.median.toFixed(1).padStart(6)}  ${stats.p90.toFixed(1).padStart(6)}  ${stats.max.toFixed(1).padStart(6)}`,
  )
}

// --- whole tool call through the gate -------------------------------------
// `DSH_HOME` is redirected so the plugin's real policy and audit never see this
// run. Boot (binary lookup, version probe, doctor, policy write) happens once
// per mode and is warmed before timing.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-bench-'))
process.env.DSH_HOME = scratch

const NEXT = Symbol('next')

function gateFor(crossCheck) {
  const { settings, warnings } = normalizeConfig({ enabled: true, crossCheckDialects: crossCheck })
  if (warnings.length > 0) throw new Error(warnings.join('; '))
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, options) {
      registered.push({ event, listener, options })
      return () => {}
    },
    effect(body) {
      const iterator = body()
      const returned = []
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
  arm(ctx, settings)
  const listener = registered.find((entry) => entry.event === 'tools/pre-execute')?.listener
  if (listener === undefined) throw new Error('the gate registered no listener')
  const call = (command) => ({
    name: 'bash',
    arguments: { command },
    callId: 'bench',
    agent: { session: { id: 'bench', header: { id: 'bench', cwd: process.cwd() } } },
  })
  return { listener, call }
}

async function timeGate(crossCheck) {
  const gate = gateFor(crossCheck)
  await gate.listener(gate.call('ls -la'), async () => NEXT) // warm the boot
  const allow = []
  const deny = []
  for (let index = 0; index < runs; index += 1) {
    let started = process.hrtime.bigint()
    await gate.listener(gate.call('ls -la'), async () => NEXT)
    allow.push(Number(process.hrtime.bigint() - started) / 1e6)

    started = process.hrtime.bigint()
    await gate.listener(gate.call('rm -rf ./build'), async () => NEXT)
    deny.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  return { allow: summarise(allow), deny: summarise(deny) }
}

try {
  console.log('')
  console.log('whole tool call              n   allow med   deny med   allow p90')
  for (const mode of ['never', 'on-allow']) {
    const stats = await timeGate(mode)
    console.log(
      `${(mode === 'never' ? 'single pass (never)' : 'double pass (on-allow)').padEnd(26)} ${String(runs).padStart(4)}  ${stats.allow.median.toFixed(1).padStart(9)}  ${stats.deny.median.toFixed(1).padStart(9)}  ${stats.allow.p90.toFixed(1).padStart(9)}`,
    )
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
