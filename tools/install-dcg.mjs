#!/usr/bin/env node
/**
 * Install the pinned dcg release into this plugin's managed directory.
 *
 *   node tools/install-dcg.mjs
 *
 * Downloads the asset that matches this platform, verifies it against the digest
 * baked into lib/install.js, and unpacks it under `$DSH_HOME/dsh-shell-dcg/bin/`.
 * Nothing else changes: the plugin still finds the binary through `resolveBinary`,
 * and an install at the front of that order takes precedence over PATH.
 */

import { installManaged, PINNED_VERSION, releaseUrl, targetFor } from '../lib/install.js'

const target = targetFor()
if (target === undefined) {
  console.error(`no pinned dcg build for ${process.platform}-${process.arch}; set dcgPath instead`)
  process.exit(1)
}

console.log(`dcg     ${PINNED_VERSION}`)
console.log(`asset   ${target.asset}`)
console.log(`sha256  ${target.sha256}`)
console.log(`from    ${releaseUrl(PINNED_VERSION, target.asset)}`)
console.log('')

let shown = 0
const result = await installManaged({
  onProgress: (bytes) => {
    const mib = bytes / (1024 * 1024)
    if (mib - shown < 0.5) return
    shown = mib
    process.stdout.write(`  ${mib.toFixed(1)} MiB\r`)
  },
})
if (shown > 0) process.stdout.write(`${' '.repeat(20)}\r`)
if (result.ok !== true) {
  console.error(`failed: ${result.reason}`)
  process.exit(1)
}

console.log(`installed ${result.path}`)
console.log(`bytes     ${result.bytes}`)
