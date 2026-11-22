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

import { auditDir } from './config.js'

/** Create the audit sink for one armed gate. */
export function createAudit(settings, env = process.env) {
  const directory = auditDir(env)
  let pruned = false

  /**
   * Append one record.
   * @param entry - JSON-serializable fields; `ts` is added here.
   */
  function record(entry) {
    if (!settings.audit.enabled) return
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

  function countLines(file) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      return text.split('\n').filter((line) => line.length > 0).length
    } catch {
      return 0
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

/** Local calendar day, so an audit file matches the day the user experienced. */
export function localDay(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
