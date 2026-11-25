#!/usr/bin/env node
/**
 * Which dcg releases still need a snapshot on one platform.
 *
 * Reads release tags on stdin, one per line, exactly as `gh release list` prints
 * them:
 *
 *   gh release list --repo Dicklesworthstone/destructive_command_guard \
 *     --limit 100 --json tagName --jq '.[].tagName' | node tools/compat-plan.mjs
 *
 * Keeps the stable `vX.Y.Z` tags at or above `minVersion`, drops the ones that
 * already have both families recorded for the platform, and prints the rest
 * oldest first — so one run fills every gap instead of one dispatch per release.
 * With stdin empty it prints nothing; that is "up to date", not an error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, normalizeConfig } from '../lib/config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FAMILIES = ['plugin', 'all']

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const platform = option('platform', `${process.platform}-${process.arch}`)
const dir = path.join(root, 'test', 'compat', 'dcg', platform)
const minVersion = normalizeConfig({}).settings.minVersion

const recorded = (version) => FAMILIES.every((family) => fs.existsSync(path.join(dir, `${version}-${family}.json`)))

const stdin = fs.readFileSync(0, 'utf8')
const versions = new Set()
for (const line of stdin.split('\n')) {
  // Stable releases only: a prerelease tag is not something minVersion covers.
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(line.trim())
  if (match !== null) versions.add(match[1])
}

const missing = [...versions]
  .filter((version) => compareVersions(version, minVersion) >= 0)
  .filter((version) => !recorded(version))
  .sort(compareVersions)

process.stdout.write(missing.map((version) => `${version}\n`).join(''))
