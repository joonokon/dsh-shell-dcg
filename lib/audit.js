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
        prune(settings.audit.retentionDays)
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
      fs.appendFileSync(path.join(directory, `${localDay(new Date())}.jsonl`), `${line}\n`, 'utf8')
    } catch {
      // Auditing must never fail a tool call.
    }
  }

  /** Delete day files older than the retention window. Runs at most once per process. */
  function prune(retentionDays) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    let names
    try {
      names = fs.readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const day = name.slice(0, -'.jsonl'.length)
      const stamp = Date.parse(`${day}T00:00:00`)
      if (Number.isNaN(stamp) || stamp >= cutoff) continue
      try {
        fs.unlinkSync(path.join(directory, name))
      } catch {
        // A file held open by another process simply survives this sweep.
      }
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
