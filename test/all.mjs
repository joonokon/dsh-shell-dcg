/**
 * Test entry point: run every test file, then report.
 *
 * `npm test` used to chain the files with `&&`, so the first failure hid the
 * verdict of every file behind it — a red run told you about smoke.mjs and
 * nothing else. Each file still runs in its own process (they redirect
 * `DSH_HOME` and make scratch directories, so a shared process would be
 * fragile), but a failure no longer stops the rest.
 *
 * Run: node test/all.mjs
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

// Cheapest first, so an entry-point break is visible before the slow run.
const files = ['entry.mjs', 'gate.mjs', 'http.mjs', 'smoke.mjs']

const failed = []
const blocked = []
for (const file of files) {
  process.stdout.write(`\n=== ${file} ===\n`)
  const result = spawnSync(process.execPath, [path.join(dir, file)], { stdio: 'inherit' })
  if (result.error !== undefined && (result.error.code === 'EPERM' || result.error.code === 'EACCES')) {
    // A sandbox that refuses child processes is not a failing test, but the file
    // did not run either, so the run cannot be called green.
    process.stdout.write(`BLOCKED ${file}: cannot start a child process (${result.error.code})\n`)
    blocked.push(file)
  } else if (result.status !== 0) {
    failed.push(file)
  }
}

const ran = files.length - blocked.length
process.stdout.write(`\n${ran - failed.length}/${files.length} test files passed\n`)
if (failed.length > 0) process.stdout.write(`failed: ${failed.join(', ')}\n`)
if (blocked.length > 0) {
  process.stdout.write(
    `blocked: ${blocked.join(', ')}\n` +
      'this environment blocks child processes, so the aggregate run cannot work;\n' +
      `run a file directly instead: node test/${blocked[0]}\n`,
  )
}
if (failed.length > 0 || blocked.length > 0) process.exitCode = 1
