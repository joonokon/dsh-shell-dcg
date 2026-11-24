/**
 * Publish manifest gate: what `npm pack` ships must equal what the plugin loads
 * at run time — and the expected set is derived from disk, never hand-kept.
 *
 * `files` in package.json is an allow-list written as globs, so the only real
 * authority on the result is npm itself. This script asks npm for the tarball
 * listing and compares it against the set the repository implies:
 *
 *   - every pattern in `files`, expanded (all lib modules, locales, docs)
 *   - every path `main`, `exports`, `icon` and `dsh.bundle.patch` name
 *   - the three files npm always ships (README, LICENSE, package.json)
 *
 * A one-sided difference fails the build. That is what catches "added
 * lib/foo.js but the glob no longer matches", "declared docs/x.md that does not
 * exist", and "shipped test/ or .github/ by accident". A hand-written list
 * cannot: it was three names long while lib/ already held twelve modules.
 *
 * Run: node tools/check-pack.mjs   (or: npm run check:pack)
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const posix = (value) => value.split(path.sep).join('/')

/** Every file below `dir`, as repository-relative posix paths. */
function walk(dir, rel) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(child, childRel))
    else if (entry.isFile()) found.push(posix(childRel))
  }
  return found
}

/**
 * Expand one `files`/`exports` pattern into what it matches on disk.
 * Supports the two shapes this package uses: `dir/**\/*.ext` and `dir/*.ext`.
 */
function expand(pattern) {
  const clean = pattern.replace(/^\.\//, '')

  if (clean.includes('**')) {
    const [head, tail] = clean.split('/**/')
    const suffix = tail.replace(/^\*/, '')
    return walk(path.join(root, head), head).filter((file) => file.endsWith(suffix))
  }

  if (clean.includes('*')) {
    const dir = posix(path.dirname(clean))
    const base = path.basename(clean)
    const cut = base.indexOf('*')
    const prefix = base.slice(0, cut)
    const suffix = base.slice(cut + 1)
    return fs
      .readdirSync(path.join(root, dir))
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => posix(path.join(dir, name)))
  }

  return [clean]
}

const problems = []
const expected = new Set()

/** Add a match set, shouting when it is empty or names a file that is not there. */
function add(files, source) {
  if (files.length === 0) problems.push(`${source} matches nothing on disk`)
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`${source} names ${file}, which does not exist`)
    expected.add(file)
  }
}

for (const pattern of pkg.files ?? []) add(expand(pattern), `files: ${pattern}`)

const declared = [
  ['main', pkg.main],
  ['icon', pkg.icon],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ...Object.entries(pkg.exports ?? {})
    .filter(([, target]) => typeof target === 'string')
    .map(([key, target]) => [`exports["${key}"]`, target]),
].filter(([, target]) => typeof target === 'string')

for (const [source, target] of declared) add(expand(target), source)

// npm always includes these when present, whatever `files` says.
for (const name of ['README.md', 'LICENSE', 'package.json']) {
  if (fs.existsSync(path.join(root, name))) expected.add(name)
}

/** Ask npm what the tarball would actually contain. */
function manifestText() {
  // Escape hatch for a sandbox that refuses to start a child process, and for
  // checking the comparison against a prepared listing:
  //   npm pack --json --dry-run > pack.json
  //   PACK_MANIFEST_JSON=pack.json node tools/check-pack.mjs
  // CI leaves it unset, so the gate always believes real npm.
  const given = process.env.PACK_MANIFEST_JSON
  if (given !== undefined && given !== '') return fs.readFileSync(given, 'utf8')

  // A private cache keeps the run independent of a machine's npm state (and of
  // a sandbox that refuses to write the default one).
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-pack-'))
  const out = path.join(cache, 'pack.json')
  const capture = fs.openSync(out, 'w')
  let result
  try {
    result = spawnSync('npm', ['pack', '--json', '--dry-run', '--cache', cache], {
      cwd: root,
      // A file descriptor rather than a pipe: some sandboxes refuse to create
      // pipes, and none of npm's output needs streaming.
      stdio: ['ignore', capture, capture],
      // Windows resolves npm through npm.cmd, which Node refuses to spawn bare.
      shell: process.platform === 'win32',
      timeout: 120_000,
    })
  } finally {
    fs.closeSync(capture)
  }

  if (result.error !== undefined) throw new Error(`cannot run npm pack: ${result.error.message}`)
  const text = fs.readFileSync(out, 'utf8')
  if (result.status !== 0) throw new Error(`npm pack failed (exit ${result.status}):\n${text}`)
  return text
}

/** The file list out of an `npm pack --json` payload. */
function packedFiles() {
  const text = manifestText().trim()
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error(`npm pack printed no JSON:\n${text}`)
  const parsed = JSON.parse(text.slice(start))
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (entry === undefined || !Array.isArray(entry.files)) throw new Error('npm pack JSON has no files list')
  return entry.files.map((file) => file.path)
}

let shipped
try {
  shipped = new Set(packedFiles())
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const missing = [...expected].filter((file) => !shipped.has(file)).sort()
const extra = [...shipped].filter((file) => !expected.has(file)).sort()

/** Paths that must never reach users, called out by name when they do. */
const forbidden = ['test/', 'tools/', '.github/', 'assets/', 'AGENTS.md', 'screenshots.json', '.gitattributes']

console.log(`${shipped.size} files in the tarball, ${expected.size} expected from disk`)

if (problems.length > 0) {
  for (const problem of problems) console.error(`broken:    ${problem}`)
}
if (missing.length > 0) {
  for (const file of missing) console.error(`missing:   ${file}  (expected, not shipped)`)
}
for (const file of extra) {
  const leak = forbidden.some((bad) => (bad.endsWith('/') ? file.startsWith(bad) : file === bad))
  console.error(`${leak ? 'forbidden:' : 'unexpected:'}${file}  ${leak ? '(must not be published)' : '(shipped, not expected)'}`)
}

if (problems.length + missing.length + extra.length > 0) {
  console.error(`\n${problems.length + missing.length + extra.length} problem(s); see above`)
  process.exit(1)
}

console.log('every runtime entry is shipped, and nothing else is\n')
for (const file of [...shipped].sort()) console.log(`  ${file}`)
