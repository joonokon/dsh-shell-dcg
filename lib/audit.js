/**
 * Append-only decision audit: one JSONL file per local day.
 *
 * dcg can log decisions itself, but only on its hook entry point (`dcg test`
 * never writes that log) and with no notion of a Harness session. This file is
 * the record the plugin's status page reads back, so it stays deliberately
 * small: what was judged, what dcg said, and enough identity to trace one line
 * back to one session.
 *
 * @module dsh-shell-dcg/lib/audit
 */

import fs from 'node:fs'
import path from 'node:path'

import { AUDIT_LEVELS, auditDir } from './config.js'

/**
 * Which of the four levels one record belongs to.
 *
 * dcg speaks in six decision words and the record also carries the guard's own
 * events, but a reader only distinguishes four things: it passed, it warned, it
 * waited for a person, or it was refused. `log` is the softest allow and folds
 * in; `indeterminate` means the guard could not conclude, which the gate refuses
 * when fail-closed, so it counts as a deny. A record with no verdict at all gets
 * the level it behaved like — a failed guard or an unreadable script is a
 * refusal, script bookkeeping is a warning worth keeping.
 */
export function levelOf(record) {
  switch (record?.decision) {
    case 'allow':
    case 'log':
      return 'allow'
    case 'warn':
      return 'warn'
    case 'ask':
      return 'ask'
    case 'deny':
    case 'indeterminate':
      return 'deny'
    default:
      break
  }
  if (record?.event === 'not-ready' || record?.error !== undefined) return 'deny'
  return 'warn'
}

/** Whether a record at `level` is at or above `threshold`. */
export function meetsLevel(level, threshold) {
  const floor = AUDIT_LEVELS.indexOf(threshold)
  return AUDIT_LEVELS.indexOf(level) >= (floor === -1 ? 0 : floor)
}

/** Create the audit sink for one armed gate. */
export function createAudit(settings, env = process.env) {
  const directory = auditDir(env)
  let pruned = false

  /**
   * Append one record, unless it sits below the configured record threshold.
   * @param entry - JSON-serializable fields; `ts` is added here.
   */
  function record(entry) {
    if (!settings.audit.enabled) return
    if (!meetsLevel(levelOf(entry), settings.audit.record)) return
    try {
      fs.mkdirSync(directory, { recursive: true })
      if (!pruned) {
        pruned = true
        prune(settings.audit)
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
      fs.appendFileSync(path.join(directory, `${localDay(new Date())}.jsonl`), `${line}\n`, 'utf8')
    } catch {
      // Auditing must never fail a tool call.
    }
  }

  /**
   * Enforce both retention limits. Runs at most once per process: the goal is a
   * bounded log, not a precisely trimmed one.
   */
  function prune(audit) {
    const cutoff = Date.now() - audit.retentionDays * 24 * 60 * 60 * 1000
    let names
    try {
      names = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
    } catch {
      return
    }

    const kept = []
    for (const name of names) {
      const day = name.slice(0, -'.jsonl'.length)
      const stamp = Date.parse(`${day}T00:00:00`)
      if (Number.isNaN(stamp) || stamp >= cutoff) {
        kept.push({ name, lines: countLines(path.join(directory, name)) })
      } else {
        drop(name)
      }
    }

    // Drop whole days from the oldest end, then trim the oldest surviving file.
    let total = kept.reduce((sum, file) => sum + file.lines, 0)
    while (kept.length > 0 && total > audit.retentionEntries) {
      const oldest = kept[0]
      if (total - oldest.lines < audit.retentionEntries) break
      drop(oldest.name)
      kept.shift()
      total -= oldest.lines
    }
    if (total > audit.retentionEntries && kept.length > 0) {
      trimHead(path.join(directory, kept[0].name), total - audit.retentionEntries)
    }
  }

  function trimHead(file, count) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0)
      fs.writeFileSync(file, `${lines.slice(count).join('\n')}\n`, 'utf8')
    } catch {
      // A file another process holds open simply survives this sweep.
    }
  }

  function drop(name) {
    try {
      fs.unlinkSync(path.join(directory, name))
    } catch {
      // Same: the next boot tries again.
    }
  }

  return { record, directory }
}

/** Delete every day file, reporting how much went. */
export function clearAudit(env = process.env) {
  const directory = auditDir(env)
  let names
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return { files: 0, removed: 0 }
  }

  let removed = 0
  for (const name of names) {
    const file = path.join(directory, name)
    removed += countLines(file)
    try {
      fs.unlinkSync(file)
    } catch {
      // Leave it for the next attempt rather than report a wrong total.
    }
  }
  return { files: names.length, removed }
}

/** Non-empty lines in one file; missing or unreadable counts as zero. */
function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.split('\n').filter((line) => line.length > 0).length
  } catch {
    return 0
  }
}

/** Local calendar day, so an audit file matches the day the user experienced. */
export function localDay(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
