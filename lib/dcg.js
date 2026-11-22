/**
 * The dcg process boundary: locate the binary, run one evaluation, read the verdict.
 *
 * Every call shells out to `dcg --robot test --stdin --format json`. The command
 * travels on stdin so no shell quoting, code page, or argument-length rule can
 * mangle it, and robot mode keeps stdout pure JSON with stderr silent.
 *
 * @module dsh-shell-dcg/lib/dcg
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { KNOWN_DECISIONS, compareVersions, managedBinDir } from './config.js'

/** Cap on the verdict JSON we are willing to buffer. */
const MAX_STDOUT_BYTES = 512 * 1024
/** Cap on diagnostics kept only for error messages. */
const MAX_STDERR_BYTES = 32 * 1024
/** Grace between a timeout kill and a hard kill. */
const KILL_GRACE_MS = 250

/** Windows resolves `dcg` through PATHEXT; every other host uses the bare name. */
const BINARY_NAMES = process.platform === 'win32' ? ['dcg.exe', 'dcg'] : ['dcg']

/**
 * Locate the dcg binary in priority order: managed install, configured path, PATH.
 * @param settings - normalized plugin settings.
 * @param env - environment providing `DSH_HOME` and `PATH`.
 * @returns the chosen binary plus every candidate considered, for diagnostics.
 */
export function resolveBinary(settings, env = process.env) {
  const considered = []
  const push = (candidate) => {
    if (candidate.path === undefined || candidate.path.length === 0) return
    const exists = isFile(candidate.path)
    considered.push({ ...candidate, exists })
  }

  if (settings.preferManaged) {
    for (const managed of managedInstalls(env)) push({ path: managed, source: 'managed' })
  }
  push({ path: settings.dcgPath, source: 'config' })
  push({ path: which('dcg', env), source: 'path' })

  const chosen = considered.find((candidate) => candidate.exists === true)
  return { path: chosen?.path, source: chosen?.source, considered }
}

/** Every `dcg` this plugin installed itself, newest version first. */
export function managedInstalls(env = process.env) {
  const root = managedBinDir(env)
  let versions
  try {
    versions = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of versions) {
    if (!entry.isDirectory()) continue
    for (const name of BINARY_NAMES) {
      const candidate = path.join(root, entry.name, name)
      if (isFile(candidate)) found.push({ version: entry.name, path: candidate })
    }
  }
  found.sort((left, right) => compareVersions(right.version, left.version))
  return found.map((entry) => entry.path)
}

/**
 * Evaluate one command.
 * @param options.bin - resolved dcg executable.
 * @param options.command - the exact command text.
 * @param options.cwd - the directory the command will run in (session workspace).
 * @param options.dialect - `posix` or `ps`.
 * @param options.policyPath - the generated `DCG_CONFIG` file, when present.
 * @param options.agentName - `--agent` label so `[agents.<name>]` profiles apply.
 * @param options.timeoutMs - wall clock budget for this evaluation.
 * @returns a verdict object, or `{ ok: false, reason }` when dcg could not answer.
 */
export async function testCommand(options) {
  const result = await runDcg(options.bin, buildTestArgs(options), {
    cwd: options.cwd,
    input: options.command,
    timeoutMs: options.timeoutMs,
    env: cleanEnv(),
  })
  if (result.failure !== undefined) return { ok: false, reason: result.failure, result }
  return parseVerdict(result)
}

/**
 * The exact argv used for one evaluation.
 * @returns argv after the executable name.
 */
export function buildTestArgs(options) {
  const args = ['--robot', 'test', '--stdin', '--format', 'json', '--dialect', options.dialect]
  if (typeof options.policyPath === 'string' && options.policyPath.length > 0) {
    args.push('--config', options.policyPath)
  }
  if (typeof options.agentName === 'string' && options.agentName.length > 0) {
    args.push('--agent', options.agentName)
  }
  return args
}

/**
 * Turn one finished dcg process into a verdict.
 * @param result - `{ code, stdout }` from {@link runDcg}.
 * @returns `{ ok: true, verdict }` or `{ ok: false, reason }`.
 */
export function parseVerdict(result) {
  const text = result.stdout.trim()
  if (text.length === 0) {
    return { ok: false, reason: `dcg produced no verdict (exit ${String(result.code)})`, result }
  }

  let verdict
  try {
    verdict = JSON.parse(text)
  } catch {
    return { ok: false, reason: `dcg verdict is not JSON: ${truncate(text, 200)}`, result }
  }
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return { ok: false, reason: 'dcg verdict is not a JSON object', result }
  }
  // dcg reports its own misconfiguration as a verdict with `decision: "deny"` and
  // an `error` object (exit 3). Surfacing that as a rule match would blame the
  // command for a broken policy file, so it is reported as "no usable answer".
  if (verdict.error !== null && typeof verdict.error === 'object' && !Array.isArray(verdict.error)) {
    const detail = firstString(verdict.error.message, verdict.error.kind) ?? 'unspecified'
    return { ok: false, reason: `dcg 拒绝加载策略（${detail}）`, verdict, configError: true, result }
  }
  if (typeof verdict.decision !== 'string') {
    return { ok: false, reason: 'dcg verdict carries no decision', result }
  }
  // An unrecognized decision is a protocol the gate does not understand: report
  // it as unknown rather than guessing, so callers apply their fail-closed rule.
  if (!KNOWN_DECISIONS.includes(verdict.decision)) {
    return { ok: false, reason: `dcg returned an unknown decision "${verdict.decision}"`, verdict, result }
  }
  return { ok: true, verdict, result }
}

/**
 * Read the binary's own version.
 * @returns the dotted version string, or `undefined` when it cannot be read.
 */
export async function readVersion(bin, env = process.env) {
  const result = await runDcg(bin, ['--version'], { timeoutMs: 5000, env })
  if (result.failure !== undefined) return { version: undefined, reason: result.failure }
  const match = `${result.stdout}\n${result.stderr}`.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
  if (match === null) return { version: undefined, reason: 'dcg did not print a version' }
  return { version: match[0] }
}

/**
 * Run one dcg process to completion.
 * @returns `{ code, stdout, stderr, timedOut }` or `{ failure }` when it could not run.
 */
export function runDcg(bin, args, options = {}) {
  return new Promise((resolve) => {
    if (typeof bin !== 'string' || bin.length === 0) {
      resolve({ failure: 'no dcg executable resolved' })
      return
    }
    const cwd = usableDirectory(options.cwd)
    let child
    try {
      child = spawn(bin, args, {
        cwd,
        env: options.env ?? cleanEnv(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ failure: `cannot start dcg: ${errorMessage(error)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let overflow = false

    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }, options.timeoutMs ?? 3000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        overflow = true
        child.kill()
        return
      }
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
    })
    child.on('error', (error) => {
      settle({ failure: `cannot run dcg (${bin}): ${errorMessage(error)}` })
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        settle({ failure: `dcg timed out after ${options.timeoutMs ?? 3000} ms` })
        return
      }
      if (overflow) {
        settle({ failure: 'dcg verdict exceeded the read budget' })
        return
      }
      settle({ code, signal, stdout, stderr, timedOut: false })
    })

    if (typeof options.input === 'string') {
      child.stdin.end(options.input)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Bound concurrent evaluations so a batch of PTC inner calls cannot fork-storm the host.
 * @param max - concurrent executions allowed.
 * @returns a function wrapping one async task in a FIFO queue.
 */
export function createLimiter(max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || queue.length === 0) return
    const run = queue.shift()
    run()
  }
  return (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active += 1
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1
            next()
          })
      }
      if (active < max) run()
      else queue.push(run)
    })
}

/** Environment for a child dcg: its own DCG_* overrides are removed so only the gate decides. */
export function cleanEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('DCG_')) continue
    if (value === undefined) continue
    env[key] = value
  }
  return env
}

/** Find `dcg` on PATH without spawning a shell. */
function which(name, env) {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : ''
  if (pathValue.length === 0) return undefined
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue
    for (const candidateName of BINARY_NAMES) {
      const candidate = path.join(dir, candidateName)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function usableDirectory(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : undefined
  } catch {
    return undefined
  }
}

function isFile(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
