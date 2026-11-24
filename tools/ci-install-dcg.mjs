#!/usr/bin/env node
/**
 * CI helper: install the pinned dcg and put its directory on PATH.
 *
 * The live job runs on Windows and Linux, which is why this is not a shell step:
 * `$GITHUB_PATH` is bash syntax, `$env:GITHUB_PATH` is pwsh syntax, and the
 * installed path is platform-shaped (`dcg.exe`, backslashes, a drive letter).
 * Doing it in node keeps one recipe for both runners, and the digest check stays
 * inside `installManaged` — the download is refused unless it matches the
 * SHA-256 baked into lib/install.js.
 *
 *   node tools/ci-install-dcg.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { installManaged, PINNED_VERSION } from '../lib/install.js'

let shown = 0
const result = await installManaged({
  onProgress: (bytes) => {
    const mib = bytes / (1024 * 1024)
    if (mib - shown < 0.5) return
    shown = mib
    console.log(`  ${mib.toFixed(1)} MiB`)
  },
})

if (result.ok !== true) {
  console.error(`cannot install dcg ${PINNED_VERSION}: ${result.reason}`)
  process.exit(1)
}

const dir = path.dirname(result.path)
console.log(`installed ${result.path}`)

const target = process.env.GITHUB_PATH
if (target === undefined || target === '') {
  console.log('GITHUB_PATH is unset: add the directory above to PATH yourself')
  process.exit(0)
}

fs.appendFileSync(target, `${dir}${os.EOL}`)
console.log(`PATH += ${dir}`)
