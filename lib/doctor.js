/**
 * Readiness probe for the gate.
 *
 * "Armed" has to mean something checkable, otherwise the switch is a lie: the
 * binary exists, it is new enough, it accepts the generated policy, and it still
 * recognises a textbook destructive command while letting a harmless one pass.
 * The probes never execute the command they describe — dcg only parses it.
 *
 * @module dsh-shell-dcg/lib/doctor
 */

import { compareVersions } from './config.js'
import { readVersion, testCommand } from './dcg.js'

/** A command that must not be silently allowed: dcg ships `core.git:reset-hard` for it. */
const DENY_PROBE = 'git reset --hard HEAD~1'
/** A command that must be allowed, so a blanket-deny misconfiguration is visible. */
const ALLOW_PROBE = 'ls -la'

/**
 * Run every readiness check.
 * @param options.settings - normalized plugin settings.
 * @param options.binary - the resolved binary descriptor.
 * @param options.policyFile - the generated policy file, when one exists.
 * @param options.cwd - a directory the probes run in; defaults to the process cwd.
 * @returns `{ ok, version, checks }` where each check carries an id, outcome, and detail.
 */
export async function runDoctor({ settings, binary, policyFile, cwd, env = process.env }) {
  const checks = []
  const add = (id, ok, detail) => {
    checks.push({ id, ok, detail })
    return ok
  }

  if (binary === undefined || typeof binary.path !== 'string' || binary.path.length === 0) {
    add('binary', false, describeCandidates(binary))
    return { ok: false, checks }
  }
  add('binary', true, `${binary.path} (${binary.source ?? 'unknown source'})`)

  const { version, reason } = await readVersion(binary.path, env)
  if (version === undefined) {
    add('version', false, reason ?? 'dcg did not report a version')
    return { ok: false, checks }
  }
  const newEnough = compareVersions(version, settings.minVersion) >= 0
  add(
    'version',
    newEnough,
    newEnough
      ? `${version} (>= ${settings.minVersion})`
      : `${version} is older than the required ${settings.minVersion}`,
  )
  if (!newEnough) return { ok: false, version, checks }

  const base = {
    bin: binary.path,
    cwd,
    dialect: 'posix',
    policyPath: policyFile,
    agentName: settings.agentName,
    timeoutMs: settings.timeoutMs,
  }

  const allowProbe = await testCommand({ ...base, command: ALLOW_PROBE })
  const allowOk = allowProbe.ok === true && allowProbe.verdict.decision === 'allow'
  add('probe-allow', allowOk, describeProbe(allowProbe, ALLOW_PROBE, 'allow'))

  const denyProbe = await testCommand({ ...base, command: DENY_PROBE })
  // Any non-allow verdict proves the evaluator still sees the hazard; a
  // downgraded mode (warn/log) is a legitimate policy choice, so it passes but
  // says so in the detail line.
  const denyDecision = denyProbe.ok === true ? denyProbe.verdict.decision : undefined
  const denyOk = denyDecision !== undefined && denyDecision !== 'allow'
  add(
    'probe-deny',
    denyOk,
    denyOk
      ? `${DENY_PROBE} -> ${denyDecision}${denyProbe.verdict.rule_id ? ` (${denyProbe.verdict.rule_id})` : ''}`
      : describeProbe(denyProbe, DENY_PROBE, 'not allow'),
  )

  return { ok: checks.every((check) => check.ok), version, checks }
}

/** One-line summary of a failed doctor run, for the model-facing denial reason. */
export function describeDoctorFailure(result) {
  const failed = result.checks.filter((check) => !check.ok)
  if (failed.length === 0) return 'unknown readiness failure'
  return failed.map((check) => `${check.id}: ${check.detail}`).join('; ')
}

function describeProbe(result, command, expectation) {
  if (result.ok === false) return `"${command}" could not be evaluated: ${result.reason}`
  const verdict = result.verdict
  return `"${command}" -> ${verdict.decision}${verdict.rule_id ? ` (${verdict.rule_id})` : ''}, expected ${expectation}`
}

function describeCandidates(binary) {
  const considered = Array.isArray(binary?.considered) ? binary.considered : []
  if (considered.length === 0) {
    return 'no dcg executable was found; install dcg or set dcgPath'
  }
  const seen = considered.map((entry) => `${entry.path} [${entry.source}${entry.exists ? '' : ', missing'}]`)
  return `no usable dcg executable; considered ${seen.join(', ')}`
}
