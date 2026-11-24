/**
 * What the plugin knows about itself, gathered for one `dcg status` answer.
 *
 * Kept separate from the command surface so the same summary serves the Host
 * command, a future settings panel, and the tests, without any of them owning
 * the reading logic.
 *
 * @module dsh-shell-dcg/lib/status
 */

import fs from 'node:fs'
import path from 'node:path'

import { levelOf } from './audit.js'
import { AUDIT_LEVELS, AUDIT_LIMITS, auditDir, compareVersions } from './config.js'
import { resolveBinary, readVersion } from './dcg.js'

/**
 * Binary, version, and whether this install meets `minVersion`.
 * @returns `{ path, source, version, ok, reason }`.
 */
export async function describeBinary(settings, env = process.env) {
  const resolved = resolveBinary(settings, env)
  if (resolved.path === undefined) {
    return { path: undefined, source: undefined, version: undefined, ok: false, reason: 'no dcg executable found' }
  }
  const { version, reason } = await readVersion(resolved.path)
  if (version === undefined) {
    return { path: resolved.path, source: resolved.source, version: undefined, ok: false, reason }
  }
  const old = compareVersions(version, settings.minVersion) < 0
  return {
    path: resolved.path,
    source: resolved.source,
    version,
    ok: !old,
    reason: old ? `older than the required ${settings.minVersion}` : undefined,
  }
}

/**
 * Read the most recent verdicts out of the daily audit files.
 *
 * Filtering happens while reading, from the newest line backwards, so `limit`
 * means "the last N records you asked for" rather than "whatever is left of the
 * last N after filtering". Every day file is read regardless, because `lines`
 * answers "how much is in here" and a partial count would be a lie.
 *
 * @param options - `{ limit, decisions }`; both default to the configured values.
 * @returns `{ files, lines, recent }` — `recent` is newest last.
 */
export function summarizeAudit(settings, env = process.env, options = {}) {
  if (!settings.audit.enabled) return { files: [], lines: 0, recent: [] }

  const limit = AUDIT_LIMITS.includes(options.limit) ? options.limit : settings.audit.limit
  // An empty selection is a real answer: show nothing.
  const selected = Array.isArray(options.decisions) ? options.decisions : settings.audit.decisions
  const wanted = new Set(selected.filter((level) => AUDIT_LEVELS.includes(level)))

  const root = auditDir(env)
  let files
  try {
    files = fs
      .readdirSync(root)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
  } catch {
    return { files: [], lines: 0, recent: [] }
  }

  const recent = []
  let lines = 0
  // Newest day first, newest line first, so the first `limit` matches are the latest.
  for (const name of [...files].reverse()) {
    let text
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      continue
    }
    const dayLines = text.split('\n').filter((line) => line.trim().length > 0)
    lines += dayLines.length
    for (let index = dayLines.length - 1; index >= 0 && recent.length < limit; index -= 1) {
      const record = parseLine(dayLines[index])
      if (record === undefined || !wanted.has(levelOf(record))) continue
      recent.push(record)
    }
  }

  return { files, lines, recent: recent.reverse() }
}

/**
 * One-line summary of an audit record, for humans.
 */
export function describeRecord(record) {
  const when = typeof record.ts === 'string' ? record.ts.slice(11, 19) : '--:--:--'
  const decision = typeof record.decision === 'string' ? record.decision : (record.event ?? 'event')
  const rule = typeof record.ruleId === 'string' ? ` ${record.ruleId}` : ''
  const tool = typeof record.tool === 'string' ? record.tool : '?'
  return `${when}  ${decision.padEnd(6)} ${tool}${rule}`
}

function parseLine(line) {
  try {
    const value = JSON.parse(line)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}
