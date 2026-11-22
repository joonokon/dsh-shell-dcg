/**
 * Reading a `script_path` call so dcg can judge what the script actually runs.
 *
 * dcg only understands command strings, and a `script_path` call never carries
 * one — the file does. Rather than refusing those calls outright, the gate reads
 * the file and hands its text to dcg, which parses shell either way. Reading is
 * bounded and refuses anything it cannot faithfully interpret, so the fallback
 * is still a denial rather than a silent pass.
 *
 * @module dsh-shell-dcg/lib/script
 */

import fs from 'node:fs'
import path from 'node:path'

/** Cap on a script we are willing to read; anything larger is refused, not truncated. */
export const MAX_SCRIPT_BYTES = 256 * 1024

/**
 * Where bash will look for the script. `ops_bash` runs `bash <scriptPath>` with
 * the call's cwd, so a relative path resolves against `workdir`, and `workdir`
 * itself resolves against the session workspace.
 */
export function resolveScriptTarget(scriptPath, workdir, sessionCwd) {
  if (path.isAbsolute(scriptPath)) return path.normalize(scriptPath)
  return path.resolve(resolveWorkdir(workdir, sessionCwd), scriptPath)
}

/** The directory a call runs in: `workdir` relative to the session workspace. */
export function resolveWorkdir(workdir, sessionCwd) {
  const base = typeof sessionCwd === 'string' && sessionCwd.length > 0 ? sessionCwd : process.cwd()
  return typeof workdir === 'string' && workdir.trim().length > 0 ? path.resolve(base, workdir.trim()) : base
}

/**
 * Read one script for judging.
 * @returns `{ ok: true, text, bytes }`, or `{ ok: false, reason }` when the file
 * cannot be turned into shell text that dcg would judge the same way bash runs it.
 */
export function readScript(target, maxBytes = MAX_SCRIPT_BYTES) {
  let stat
  try {
    stat = fs.statSync(target)
  } catch (error) {
    return { ok: false, reason: `cannot stat it: ${errorMessage(error)}` }
  }
  if (stat.isDirectory()) return { ok: false, reason: 'it is a directory' }
  if (!stat.isFile()) return { ok: false, reason: 'it is not a regular file' }
  if (stat.size > maxBytes) {
    return { ok: false, reason: `it is ${stat.size} bytes, over the ${maxBytes}-byte limit` }
  }

  let buffer
  try {
    buffer = fs.readFileSync(target)
  } catch (error) {
    return { ok: false, reason: `cannot read it: ${errorMessage(error)}` }
  }
  // NUL bytes mean this is not shell text; judging a decoded blob would be a guess.
  if (buffer.includes(0)) return { ok: false, reason: 'it contains NUL bytes, so it is not shell text' }
  if (buffer.length === 0) return { ok: false, reason: 'it is empty' }

  return { ok: true, text: buffer.toString('utf8'), bytes: buffer.length }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
