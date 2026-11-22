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

import { auditDir, compareVersions } from './config.js'
import { resolveBinary, readVersion } from './dcg.js'

/** How many recent verdicts one summary carries. */
const RECENT_LIMIT = 20

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
 * @returns `{ files, lines, recent }` — `recent` is newest last.
 */
export function summarizeAudit(settings, env = process.env, limit = RECENT_LIMIT) {
  if (!settings.audit.enabled) return { files: [], lines: 0, recent: [] }

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
  // Newest day first, stop as soon as enough records are collected.
  for (const name of [...files].reverse()) {
    let text
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      continue
    }
    const dayLines = text.split('\n').filter((line) => line.trim().length > 0)
    lines += dayLines.length
    for (const line of dayLines) {
      const record = parseLine(line)
      if (record !== undefined) recent.push(record)
    }
    if (recent.length >= limit) break
  }

  return { files, lines, recent: recent.slice(-limit) }
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
