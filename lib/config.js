/**
 * Configuration defaults, validation, and the plugin's on-disk locations.
 *
 * The row config is plain YAML from `cordis.patch.yml`; this module is the one
 * place that turns it into a complete, typed settings object. It never throws:
 * a malformed value falls back to its default and reports a warning, because a
 * typo in one optional field must not take the whole plugin down.
 *
 * @module dsh-shell-dcg/lib/config
 */

import os from 'node:os'
import path from 'node:path'

/** Directory name this plugin owns under `$DSH_HOME`. Matches the package name. */
const DATA_DIR_NAME = 'dsh-shell-dcg'

/** Decisions `dcg test --format json` may report. Anything else is unknown. */
export const KNOWN_DECISIONS = Object.freeze([
  'allow',
  'deny',
  'ask',
  'warn',
  'log',
  'indeterminate',
])

/** Policy modes dcg accepts on `[policy]` and `[policy.packs]`. */
export const POLICY_MODES = Object.freeze(['deny', 'ask', 'warn', 'log'])

/** How the gate treats a command's script file when a tool runs one instead of a command string. */
export const SCRIPT_PATH_MODES = Object.freeze(['read', 'deny', 'pass'])

/** What to do when the guard itself cannot answer (dcg missing, timeout, bad JSON). */
export const NOT_READY_MODES = Object.freeze(['deny', 'pass'])

/** Shell dialect names `dcg --dialect` accepts (aliases included for readability). */
export const DIALECTS = Object.freeze(['posix', 'ps', 'unknown'])

/** @returns the Harness home directory, honouring `DSH_HOME` exactly like the Host does. */
export function dshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return explicit.length > 0 ? explicit : path.join(os.homedir(), '.dsh')
}

/** @returns this plugin's private data directory (`$DSH_HOME/dsh-shell-dcg`). */
export function dataDir(env = process.env) {
  return path.join(dshHome(env), DATA_DIR_NAME)
}

/** @returns the directory holding generated artifacts, chiefly `policy.toml`. */
export function generatedDir(env = process.env) {
  return path.join(dataDir(env), 'generated')
}

/** @returns the `DCG_CONFIG` file this plugin generates and owns. */
export function policyPath(env = process.env) {
  return path.join(generatedDir(env), 'policy.toml')
}

/** @returns the directory of one JSONL audit file per day. */
export function auditDir(env = process.env) {
  return path.join(dataDir(env), 'audit')
}

/** @returns the directory a managed dcg install lives under, one folder per version. */
export function managedBinDir(env = process.env) {
  return path.join(dataDir(env), 'bin')
}

/** The complete default settings object. Deep-frozen so callers cannot mutate it. */
export const DEFAULTS = deepFreeze({
  enabled: false,
  dcgPath: '',
  preferManaged: true,
  minVersion: '0.16.0',
  agentName: 'dsh',
  failClosed: true,
  onNotReady: 'deny',
  dryRun: false,
  tools: ['ops_bash', 'bash', 'pwsh', 'ssh_exec'],
  commandField: 'command',
  scriptPathField: 'script_path',
  workdirField: 'workdir',
  scriptPath: 'read',
  dialects: { ops_bash: 'posix', bash: 'posix', pwsh: 'ps', ssh_exec: 'posix' },
  defaultDialect: 'posix',
  onAsk: 'ask',
  onWarn: 'allow',
  timeoutMs: 3000,
  maxConcurrent: 4,
  policy: {
    packs: [],
    // Empty means "say nothing": dcg then applies its own severity defaults
    // (critical/high -> deny, medium -> warn, low -> log). Writing a mode here
    // flattens that ladder, so it stays unset unless someone asks for a flat
    // policy on purpose.
    defaultMode: '',
    observeUntil: '',
    packModes: {},
  },
  audit: {
    enabled: true,
    keepCommandText: false,
    retentionDays: 30,
  },
})

/**
 * Merge one row config over the defaults.
 * @param raw - the row's config as the loader delivered it (any JSON value).
 * @returns the effective settings plus any warnings about ignored values.
 */
export function normalizeConfig(raw) {
  const warnings = []
  const input = isRecord(raw) ? raw : {}
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    warnings.push('config is not an object; using defaults')
  }

  const settings = {
    enabled: boolOf(input.enabled, DEFAULTS.enabled, 'enabled', warnings),
    dcgPath: stringOf(input.dcgPath, DEFAULTS.dcgPath, 'dcgPath', warnings),
    preferManaged: boolOf(input.preferManaged, DEFAULTS.preferManaged, 'preferManaged', warnings),
    minVersion: stringOf(input.minVersion, DEFAULTS.minVersion, 'minVersion', warnings),
    agentName: stringOf(input.agentName, DEFAULTS.agentName, 'agentName', warnings),
    failClosed: boolOf(input.failClosed, DEFAULTS.failClosed, 'failClosed', warnings),
    onNotReady: enumOf(input.onNotReady, NOT_READY_MODES, DEFAULTS.onNotReady, 'onNotReady', warnings),
    dryRun: boolOf(input.dryRun, DEFAULTS.dryRun, 'dryRun', warnings),
    tools: stringListOf(input.tools, DEFAULTS.tools, 'tools', warnings),
    commandField: stringOf(input.commandField, DEFAULTS.commandField, 'commandField', warnings),
    scriptPathField: stringOf(input.scriptPathField, DEFAULTS.scriptPathField, 'scriptPathField', warnings),
    workdirField: stringOf(input.workdirField, DEFAULTS.workdirField, 'workdirField', warnings),
    scriptPath: enumOf(input.scriptPath, SCRIPT_PATH_MODES, DEFAULTS.scriptPath, 'scriptPath', warnings),
    dialects: dialectsOf(input.dialects, warnings),
    defaultDialect: enumOf(input.defaultDialect, DIALECTS, DEFAULTS.defaultDialect, 'defaultDialect', warnings),
    onAsk: enumOf(input.onAsk, ['ask', 'deny', 'allow'], DEFAULTS.onAsk, 'onAsk', warnings),
    onWarn: enumOf(input.onWarn, ['allow', 'ask', 'deny'], DEFAULTS.onWarn, 'onWarn', warnings),
    timeoutMs: intOf(input.timeoutMs, 100, 60000, DEFAULTS.timeoutMs, 'timeoutMs', warnings),
    maxConcurrent: intOf(input.maxConcurrent, 1, 32, DEFAULTS.maxConcurrent, 'maxConcurrent', warnings),
    policy: policyOf(input.policy, warnings),
    audit: auditOf(input.audit, warnings),
  }
  return { settings: deepFreeze(settings), warnings }
}

/** Whether this tool's calls are judged at all. */
export function judges(settings, toolName) {
  return settings.tools.includes(toolName)
}

/** The `--dialect` value for one tool. */
export function dialectFor(settings, toolName) {
  const configured = settings.dialects[toolName]
  return typeof configured === 'string' && configured.length > 0 ? configured : settings.defaultDialect
}

/**
 * Extract the command string from one tool's parsed arguments.
 * @returns the command, or `{ scriptPath }` when the call runs a script file instead,
 *          or `undefined` when this call carries no command at all.
 */
export function extractCommand(settings, args) {
  if (!isRecord(args)) return undefined
  const command = args[settings.commandField]
  if (typeof command === 'string' && command.trim().length > 0) return command
  const scriptPath = args[settings.scriptPathField]
  if (typeof scriptPath === 'string' && scriptPath.trim().length > 0) return { scriptPath }
  return undefined
}

/** Compare dotted numeric versions. Absent segments count as zero. */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  return 0
}

function versionParts(value) {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((part) => {
      const digits = part.match(/^\d+/)
      return digits === null ? 0 : Number(digits[0])
    })
}

function policyOf(raw, warnings) {
  const input = isRecord(raw) ? raw : {}
  const packs = stringListOf(input.packs, DEFAULTS.policy.packs, 'policy.packs', warnings)
  const packModes = {}
  if (isRecord(input.packModes)) {
    for (const [packId, mode] of Object.entries(input.packModes)) {
      if (typeof mode !== 'string' || !POLICY_MODES.includes(mode)) {
        warnings.push(`policy.packModes["${packId}"] is not one of ${POLICY_MODES.join(', ')}; ignored`)
        continue
      }
      packModes[packId] = mode
    }
  } else if (input.packModes !== undefined) {
    warnings.push('policy.packModes is not an object; ignored')
  }
  return {
    packs,
    defaultMode: enumOf(input.defaultMode, ['', ...POLICY_MODES], DEFAULTS.policy.defaultMode, 'policy.defaultMode', warnings),
    observeUntil: dateOf(input.observeUntil, 'policy.observeUntil', warnings),
    packModes,
  }
}

function auditOf(raw, warnings) {
  const input = isRecord(raw) ? raw : {}
  if (raw !== undefined && !isRecord(raw)) warnings.push('audit is not an object; using defaults')
  return {
    enabled: boolOf(input.enabled, DEFAULTS.audit.enabled, 'audit.enabled', warnings),
    keepCommandText: boolOf(input.keepCommandText, DEFAULTS.audit.keepCommandText, 'audit.keepCommandText', warnings),
    retentionDays: intOf(input.retentionDays, 1, 3650, DEFAULTS.audit.retentionDays, 'audit.retentionDays', warnings),
  }
}

function dialectsOf(raw, warnings) {
  const input = isRecord(raw) ? raw : {}
  const merged = { ...DEFAULTS.dialects }
  for (const [tool, dialect] of Object.entries(input)) {
    if (typeof dialect !== 'string' || !DIALECTS.includes(dialect)) {
      warnings.push(`dialects["${tool}"] is not one of ${DIALECTS.join(', ')}; ignored`)
      continue
    }
    merged[tool] = dialect
  }
  return merged
}

function boolOf(value, fallback, label, warnings) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    warnings.push(`${label} is not a boolean; using ${String(fallback)}`)
    return fallback
  }
  return value
}

function stringOf(value, fallback, label, warnings) {
  if (value === undefined) return fallback
  if (typeof value !== 'string') {
    warnings.push(`${label} is not a string; using the default`)
    return fallback
  }
  return value.trim()
}

function enumOf(value, allowed, fallback, label, warnings) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    warnings.push(`${label} must be one of ${allowed.filter((v) => v !== '').join(', ')}; using ${String(fallback)}`)
    return fallback
  }
  return value
}

function intOf(value, min, max, fallback, label, warnings) {
  if (value === undefined) return fallback
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || Math.trunc(number) !== number || number < min || number > max) {
    warnings.push(`${label} must be an integer in [${min}, ${max}]; using ${fallback}`)
    return fallback
  }
  return number
}

function stringListOf(value, fallback, label, warnings) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    warnings.push(`${label} must be an array of strings; using the default`)
    return [...fallback]
  }
  return value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

function dateOf(value, label, warnings) {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    warnings.push(`${label} is not a string; ignored`)
    return ''
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?Z?)?$/.test(trimmed)) {
    warnings.push(`${label} is not an ISO date such as 2026-11-30; ignored`)
    return ''
  }
  return trimmed
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
