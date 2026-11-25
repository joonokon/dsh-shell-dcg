#!/usr/bin/env node
/**
 * Compatibility evidence for dcg: one snapshot per version, compared as a chain.
 *
 * The plugin decides nothing about what is destructive — that lives in the dcg
 * binary, whose rules, severities and JSON shape can change between releases.
 * This tool records what one binary actually answers for a fixed corpus, so a
 * newer dcg can be compared against the older one as data, not as prose.
 *
 * Two families, because "dcg defaults" and "every pack" answer different
 * questions and dcg ships most packs switched off:
 *
 *   defaults  an empty config, i.e. what the plugin's own policy inherits and
 *             therefore what a user actually meets;
 *   all       every pack enabled, so a rule edit inside a pack that ships
 *             disabled is still visible before anyone turns it on.
 *
 * What makes the comparison trustworthy:
 *
 *   - the corpus is committed, and every case names the pack it is meant to
 *     exercise; `coverage` reports packs that no case actually reaches;
 *   - a snapshot stores dcg's own answer, with only prose fields (`reason`,
 *     `explanation`) removed — anything dcg adds shows up as a diff;
 *   - the config is a file in this repository, passed as `--config`, which
 *     replaces dcg's whole config chain (otherwise the machine's own
 *     ~/.config/dcg/config.toml leaks into the snapshot);
 *   - equality is transitive per entry, so n-1 adjacent comparisons prove the
 *     whole window from `minVersion` to the newest snapshot.
 *
 * Usage:
 *   node tools/compat.mjs packs
 *   node tools/compat.mjs snapshot  <bin> [--family defaults|all] [--platform win32-x64]
 *   node tools/compat.mjs coverage  [snapshot] [--family defaults|all]
 *   node tools/compat.mjs diff      <snapshot-a> <snapshot-b>
 *   node tools/compat.mjs check
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareVersions, normalizeConfig } from '../lib/config.js'
import { PINNED_VERSION } from '../lib/install.js'
import { buildPolicyToml } from '../lib/policy.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const compatDir = path.join(root, 'test', 'compat')
const corpusFile = path.join(compatDir, 'corpus.json')
const planFile = path.join(compatDir, 'coverage.json')
const packsFile = path.join(compatDir, 'packs.json')
const snapshotDir = path.join(compatDir, 'dcg')

/** The platform whose chain blocks a release; others are canaries. */
const PRIMARY_PLATFORM = 'win32-x64'

/** Config files this repository owns; each `--config` replaces dcg's chain. */
const FAMILIES = {
  plugin: 'test/compat/plugin-default.toml',
  all: 'test/compat/all-packs.toml',
}
const DEFAULT_FAMILY = 'plugin'

/**
 * Fields dropped before storing an answer: prose that changes without changing
 * behaviour, and per-response copies of what the snapshot header already says.
 */
const OMITTED = new Set(['reason', 'explanation', 'command', 'dcg_version', 'robot_mode', 'schema_version'])

const platformOf = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** Stable JSON text: sorted keys, two spaces, LF, trailing newline. */
function canonical(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort)
    if (input !== null && typeof input === 'object') {
      const out = {}
      for (const key of Object.keys(input).sort()) out[key] = sort(input[key])
      return out
    }
    return input
  }
  return `${JSON.stringify(sort(value), null, 2)}\n`
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Ask one binary one question.
 *
 * dcg reads the command from stdin and writes JSON to stdout. Both are passed as
 * file descriptors rather than pipes: pipes are what a locked-down sandbox
 * refuses first, and nothing here needs streaming.
 */
function ask(bin, args, input) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dcg-compat-'))
  const stdin = path.join(scratch, 'stdin.txt')
  const stdout = path.join(scratch, 'stdout.json')
  const stderr = path.join(scratch, 'stderr.txt')
  fs.writeFileSync(stdin, input)

  const fds = [fs.openSync(stdin, 'r'), fs.openSync(stdout, 'w'), fs.openSync(stderr, 'w')]
  let result
  try {
    result = spawnSync(bin, args, { stdio: fds, timeout: 20_000 })
  } finally {
    for (const fd of fds) fs.closeSync(fd)
  }

  const out = fs.readFileSync(stdout, 'utf8')
  const err = fs.readFileSync(stderr, 'utf8')
  fs.rmSync(scratch, { recursive: true, force: true })
  return { status: result.status, error: result.error, stdout: out, stderr: err }
}

const baseArgs = (dialect, family) => [
  '--robot',
  'test',
  '--stdin',
  '--format',
  'json',
  '--dialect',
  dialect,
  '--config',
  path.join(root, FAMILIES[family]),
]

/** One normalized answer, or an error marker when the binary misbehaved. */
function judge(bin, command, dialect, family) {
  const run = ask(bin, baseArgs(dialect, family), command)
  if (run.error !== undefined) return { error: run.error.code ?? run.error.message, exitCode: run.status ?? null }
  let parsed
  try {
    parsed = JSON.parse(run.stdout)
  } catch {
    const first = `${run.stderr}`.trim().split('\n')[0] ?? ''
    return { error: `no JSON on stdout: ${first}`.slice(0, 200), exitCode: run.status ?? null }
  }
  const kept = {}
  for (const [key, value] of Object.entries(parsed)) if (!OMITTED.has(key)) kept[key] = value
  kept.exitCode = run.status
  return kept
}

function versionOf(bin) {
  const run = ask(bin, ['--version'], '')
  const match = `${run.stdout}\n${run.stderr}`.match(/\d+\.\d+\.\d+/)
  return match === null ? undefined : match[0]
}

/** The pack catalog, names and pattern counts only. */
function packsOf(bin) {
  // `dcg packs` takes no --config, so it always reflects whatever user
  // configuration the machine has. Only the catalog is read from it: which packs
  // are on is asserted by the corpus and proven by the snapshot, which does run
  // with a config this repository owns.
  const run = ask(bin, ['packs', '--format', 'json'], '')
  const parsed = JSON.parse(run.stdout)
  return parsed.packs.map((pack) => ({
    id: pack.id,
    name: pack.name,
    category: pack.category,
    safePatterns: pack.safe_pattern_count ?? 0,
    destructivePatterns: pack.destructive_pattern_count ?? 0,
  }))
}

/** Every case in the corpus, flattened: { pack, id, command, dialects }. */
function cases() {
  const corpus = readJson(corpusFile)
  const defaults = corpus.defaultDialects ?? ['posix']
  const out = []
  for (const [pack, list] of Object.entries(corpus.packs)) {
    for (const item of list) {
      out.push({ pack, id: item.id, command: item.command, dialects: item.dialects ?? defaults })
    }
  }
  return { corpus, cases: out }
}

const snapshotPath = (platform, version, family) => path.join(snapshotDir, platform, `${version}-${family}.json`)

/** Snapshots for one platform, grouped by family and sorted by version. */
function snapshotsFor(platform) {
  const dir = path.join(snapshotDir, platform)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const stem = file.slice(0, -'.json'.length)
      const cut = stem.lastIndexOf('-')
      return { version: stem.slice(0, cut), family: stem.slice(cut + 1), file: path.join(dir, file) }
    })
    .filter((entry) => FAMILIES[entry.family] !== undefined)
    .sort((a, b) => compareVersions(a.version, b.version))
}

/** All snapshots in the repo, keyed `${platform}|${family}`. */
function allSnapshots() {
  const grouped = new Map()
  if (!fs.existsSync(snapshotDir)) return grouped
  for (const platform of fs.readdirSync(snapshotDir)) {
    const dir = path.join(snapshotDir, platform)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const entry of snapshotsFor(platform)) {
      const key = `${platform}|${entry.family}`
      if (!grouped.has(key)) grouped.set(key, { platform, family: entry.family, list: [] })
      grouped.get(key).list.push({ ...entry, body: readJson(entry.file) })
    }
  }
  return grouped
}

function corpusHashes() {
  return { corpus: sha256(canonical(readJson(corpusFile))), packs: sha256(canonical(readJson(packsFile))) }
}

// -- commands -----------------------------------------------------------------

function commandPacks(bin) {
  const version = versionOf(bin) ?? 'unknown'
  const catalog = packsOf(bin)
  fs.writeFileSync(packsFile, canonical({ dcg: version, packs: catalog }))

  // The all-packs config is generated from the same catalog, so the two cannot
  // drift: adding a pack upstream shows up as a corpus gap, not as silence.
  const ids = catalog.map((pack) => pack.id).sort()
  const lines = [
    '# Every pack switched on: the compat corpus then exercises each rule set, so a',
    '# change inside a pack that ships disabled is still visible in the chain.',
    '# Generated by `node tools/compat.mjs packs` — do not edit by hand.',
    '',
    '[packs]',
    'enabled = [',
    ...ids.map((id) => `  ${JSON.stringify(id)},`),
    ']',
    '',
  ]
  fs.writeFileSync(path.join(compatDir, 'all-packs.toml'), lines.join('\n'))
  console.log(`${catalog.length} packs → test/compat/packs.json and test/compat/all-packs.toml`)
}

function commandPolicy() {
  const { settings } = normalizeConfig({})
  const text = buildPolicyToml(settings)
  const target = path.join(compatDir, 'plugin-default.toml')
  fs.writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`)
  const packs = settings.policy.packs.length > 0 ? settings.policy.packs.join(', ') : 'none'
  console.log(`plugin default policy (extra packs: ${packs}) → test/compat/plugin-default.toml`)
}

function commandSnapshot(bin, family, explicitPlatform) {
  const version = versionOf(bin)
  if (version === undefined) {
    console.error(`cannot read a version from ${bin}`)
    process.exit(1)
  }
  const platform = explicitPlatform ?? platformOf()
  const { cases: all } = cases()
  const hashes = corpusHashes()

  const results = {}
  for (const item of all) {
    for (const dialect of item.dialects) {
      results[`${item.id}|${dialect}`] = judge(bin, item.command, dialect, family)
    }
  }

  const body = {
    schema: 1,
    dcg: version,
    platform,
    family,
    binary: {
      name: path.basename(bin),
      sha256: sha256(fs.readFileSync(bin)),
      bytes: fs.statSync(bin).size,
    },
    config: FAMILIES[family],
    ...hashes,
    results,
  }

  const target = snapshotPath(platform, version, family)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, canonical(body))
  console.log(`${version} on ${platform} [${family}]: ${Object.keys(results).length} answers → ${path.relative(root, target)}`)
}

function commandCoverage(file, family, platform = PRIMARY_PLATFORM) {
  const packs = readJson(packsFile).packs
  const { corpus } = cases()
  const plan = readJson(planFile)
  const limits = plan.limits ?? {}

  // Newest snapshot of this family whose corpus still matches: a snapshot taken
  // before the last corpus edit says nothing about the cases added since, so
  // coverage refuses to grade stale evidence.
  const candidates = snapshotsFor(platform)
    .filter((entry) => entry.family === family)
    .map((entry) => ({ ...entry, body: readJson(entry.file) }))
    .filter((entry) => entry.body.corpus === corpusHashes().corpus)
  const target = file ?? candidates.at(-1)?.file
  if (target === undefined || !fs.existsSync(target)) {
    console.error(
      `no ${family} snapshot on ${platform} matches the current corpus; run: node tools/compat.mjs snapshot <bin> --family ${family} --platform ${platform}`,
    )
    process.exit(1)
  }
  const snapshot = readJson(target)
  const active = snapshot.family

  const hits = new Map()
  for (const [key, answer] of Object.entries(snapshot.results)) {
    if (answer?.pack_id === undefined) continue
    if (!hits.has(answer.pack_id)) hits.set(answer.pack_id, [])
    hits.get(answer.pack_id).push({
      key,
      pattern: answer.pattern_name ?? answer.rule_id,
      decision: answer.decision,
      severity: answer.severity,
    })
  }

  const familyPlan = plan.families?.[active] ?? {}
  const mustHit = familyPlan.allPacks === true ? packs.map((pack) => pack.id) : (familyPlan.mustHit ?? [])
  const mustStayQuiet = familyPlan.allPacks === true ? [] : (familyPlan.mustStayQuiet ?? [])

  const need = limits.enabledHits ?? 2
  const problems = []

  const known = new Set(packs.map((pack) => pack.id))
  const extra = new Set(plan.extraPacks ?? [])
  for (const id of hits.keys()) {
    if (!known.has(id) && !extra.has(id)) {
      problems.push(`${id}: the snapshot reports this pack, but it is neither in the catalog nor in coverage.json extraPacks`)
    }
  }

  // Packs a broader pack shadows: their only rules are also matched by a pack
  // that dcg checks first, so no command can reach them. Declaring one keeps the
  // gap visible instead of silently dropping it — and the waiver has to stay
  // true: if the pack ever starts matching, the declaration is stale.
  const shadowed = plan.shadowed ?? {}
  const waivers = plan.waivers ?? {}
  for (const [pack, reason] of Object.entries(shadowed)) {
    if (!known.has(pack)) problems.push(`shadowed: ${pack} is not in the catalog`)
    if (waivers[pack] !== undefined) problems.push(`${pack}: both shadowed and waived`)
    if ((hits.get(pack) ?? []).length > 0) {
      problems.push(`${pack}: declared shadowed (${reason}) but the snapshot does hit it; drop the waiver`)
    }
  }
  for (const pack of Object.keys(waivers)) if (!known.has(pack)) problems.push(`waivers: ${pack} is not in the catalog`)

  for (const pack of mustHit) {
    if ((corpus.packs[pack] ?? []).length === 0) problems.push(`${pack}: declared mustHit but the corpus has no case for it`)
    if (shadowed[pack] !== undefined) continue
    const got = hits.get(pack) ?? []
    if (waivers[pack] !== undefined) {
      if (got.length === 0) problems.push(`${pack}: waived (${waivers[pack]}) but the corpus does not reach it at all`)
      continue
    }
    if (got.length < need) {
      problems.push(`${pack}: ${got.length} hit(s), need ${need} — the corpus does not reach this pack`)
    }
  }

  // Diversity is a corpus-level property: every severity and decision class dcg
  // emits must be exercised somewhere, which is what "different degrees of the
  // same command" comes down to once dcg's own answer is the source of truth.
  // It is per family, because the default install only ever denies.
  const allHits = [...hits.values()].flat()
  const seeSeverities = new Set(allHits.map((entry) => entry.severity).filter((value) => value !== undefined))
  const seeDecisions = new Set(allHits.map((entry) => entry.decision))
  const globalPlan = familyPlan.global ?? {}
  for (const severity of globalPlan.severities ?? []) {
    if (!seeSeverities.has(severity)) problems.push(`no case produces severity ${severity}`)
  }
  for (const decision of globalPlan.decisions ?? []) {
    if (!seeDecisions.has(decision)) problems.push(`no case produces decision ${decision}`)
  }
  for (const pack of mustStayQuiet) {
    if ((corpus.packs[pack] ?? []).length < (limits.disabledCases ?? 1)) problems.push(`${pack}: declared quiet but has no case`)
    const got = hits.get(pack) ?? []
    if (got.length > 0) problems.push(`${pack}: ${got.length} hit(s) although it is expected to be off by default (${got[0].key})`)
  }

  const covered = mustHit.filter((pack) => (hits.get(pack) ?? []).length >= need).length
  console.log(`${path.relative(root, target)} [${active}]`)
  console.log(`packs exercised: ${covered}/${mustHit.length} must-hit, ${mustStayQuiet.length} must stay quiet`)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(`\n${problems.length} coverage problem(s)`)
  } else {
    console.log('every declared pack behaves as the corpus says')
  }
  process.exitCode = problems.length > 0 ? 1 : 0
}

function commandDiff(fileA, fileB) {
  const a = readJson(fileA)
  const b = readJson(fileB)
  const keys = new Set([...Object.keys(a.results), ...Object.keys(b.results)])
  let shown = 0
  for (const key of [...keys].sort()) {
    const left = a.results[key]
    const right = b.results[key]
    if (JSON.stringify(left) === JSON.stringify(right)) continue
    shown += 1
    const fields = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])
    const parts = []
    for (const field of [...fields].sort()) {
      const from = JSON.stringify(left?.[field])
      const to = JSON.stringify(right?.[field])
      if (from !== to) parts.push(`${field}: ${from ?? '-'} → ${to ?? '-'}`)
    }
    console.log(`${key}\n  ${parts.join('\n  ')}`)
  }
  console.log(`\n${shown} differing answer(s) between ${a.dcg} and ${b.dcg}`)
  process.exitCode = shown === 0 ? 0 : 1
}

function commandCheck() {
  const problems = []
  const note = (text) => problems.push(text)

  const { corpus, cases: all } = cases()
  const packs = readJson(packsFile).packs
  const plan = readJson(planFile)
  const packIds = new Set(packs.map((pack) => pack.id))
  const hashes = corpusHashes()
  const minVersion = normalizeConfig({}).settings.minVersion

  // Every pack dcg ships must be classified, so a new upstream pack cannot slip
  // in unexercised: the run fails until someone decides which side it belongs on.
  for (const [name, familyPlan] of Object.entries(plan.families ?? {})) {
    if (FAMILIES[name] === undefined) note(`coverage: unknown family ${name}`)
    for (const pack of familyPlan.mustHit ?? []) if (!packIds.has(pack)) note(`coverage: ${name}.mustHit names unknown pack ${pack}`)
    for (const pack of familyPlan.mustStayQuiet ?? []) if (!packIds.has(pack)) note(`coverage: ${name}.mustStayQuiet names unknown pack ${pack}`)
  }
  const defaultsPlan = plan.families?.[DEFAULT_FAMILY] ?? {}
  const mustHit = new Set(defaultsPlan.mustHit ?? [])
  const quiet = new Set(defaultsPlan.mustStayQuiet ?? [])
  const extraPacks = new Set(plan.extraPacks ?? [])
  for (const id of extraPacks) if (packIds.has(id)) note(`coverage: ${id} is in the catalog, so it does not belong in extraPacks`)
  for (const pack of mustHit) if (quiet.has(pack)) note(`coverage: ${pack} is both mustHit and mustStayQuiet`)
  if (defaultsPlan.allPacks !== true) {
    for (const pack of packIds) {
      if (!mustHit.has(pack) && !quiet.has(pack)) note(`coverage: pack ${pack} is unclassified; add it to mustHit or mustStayQuiet`)
    }
  }
  for (const pack of Object.keys(corpus.packs)) {
    if (!packIds.has(pack)) note(`corpus: cases for unknown pack ${pack}`)
  }

  const seen = new Set()
  for (const item of all) {
    if (seen.has(item.id)) note(`corpus: duplicate case id ${item.id}`)
    seen.add(item.id)
    if (!packIds.has(item.pack)) note(`corpus: ${item.id} names unknown pack ${item.pack}`)
    if (item.dialects.length === 0) note(`corpus: ${item.id} has no dialects`)
  }

  const grouped = allSnapshots()
  for (const [key, group] of grouped) {
    for (const { version, body, file } of group.list) {
      const where = path.relative(root, file)
      if (body.dcg !== version) note(`${where}: header says ${body.dcg}, filename says ${version}`)
      if (body.platform !== group.platform) note(`${where}: header says ${body.platform}, directory says ${group.platform}`)
      if (body.family !== group.family) note(`${where}: header says ${body.family}, filename says ${group.family}`)
      if (body.corpus !== hashes.corpus) note(`${where}: corpus changed since this snapshot; regenerate it`)
      if (body.packs !== hashes.packs) note(`${where}: pack catalog changed since this snapshot; regenerate it`)
      for (const [key, answer] of Object.entries(body.results)) {
        const id = answer?.pack_id
        if (id === undefined || packIds.has(id) || extraPacks.has(id)) continue
        note(`${where}: ${key} reports unknown pack ${id}; add it to coverage.json extraPacks or regenerate the catalog`)
      }
    }

    for (let index = 1; index < group.list.length; index += 1) {
      const older = group.list[index - 1]
      const newer = group.list[index]
      const differs = Object.keys(newer.body.results).filter(
        (entry) => JSON.stringify(newer.body.results[entry]) !== JSON.stringify(older.body.results[entry]),
      )
      if (differs.length === 0) continue
      const waived = compareVersions(older.version, minVersion) < 0
      const detail = `${key}: ${older.version} → ${newer.version} differs in ${differs.length} answer(s) (${differs.slice(0, 3).join(', ')}${differs.length > 3 ? '…' : ''})`
      if (waived) {
        console.log(`note: ${detail}; allowed because minVersion ${minVersion} is past ${older.version}`)
      } else {
        note(`${detail}; raise minVersion above ${older.version} or update the corpus deliberately`)
      }
    }
  }

  const defaultsChain = grouped.get(`${PRIMARY_PLATFORM}|${DEFAULT_FAMILY}`)?.list ?? []
  if (defaultsChain.length === 0) note(`no ${DEFAULT_FAMILY} snapshot for the primary platform ${PRIMARY_PLATFORM}`)
  if (!defaultsChain.some((entry) => entry.version === PINNED_VERSION)) {
    note(`${PRIMARY_PLATFORM}/${DEFAULT_FAMILY}: no snapshot for the pinned version ${PINNED_VERSION}`)
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL ${problem}`)
    console.error(`\n${problems.length} problem(s); minVersion is ${minVersion}, pinned is ${PINNED_VERSION}`)
    process.exitCode = 1
    return
  }
  const total = [...grouped.values()].reduce((sum, group) => sum + group.list.length, 0)
  console.log(`ok: ${total} snapshot(s) in ${grouped.size} chain(s), corpus and catalog match, chains unbroken (minVersion ${minVersion})`)
}

// -- entry point --------------------------------------------------------------

const argv = process.argv.slice(2)
const command = argv[0]

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

const family = option('family', DEFAULT_FAMILY)
if (FAMILIES[family] === undefined) {
  console.error(`unknown family ${family}; expected ${Object.keys(FAMILIES).join(' or ')}`)
  process.exit(2)
}
const positional = []
for (let index = 1; index < argv.length; index += 1) {
  const value = argv[index]
  if (value === '--family' || value === '--platform') {
    index += 1
    continue
  }
  if (!value.startsWith('--')) positional.push(value)
}

switch (command) {
  case 'packs':
    commandPacks(positional[0] ?? path.join(os.homedir(), '.local', 'bin', 'dcg'))
    break
  case 'policy':
    commandPolicy()
    break
  case 'snapshot':
    if (positional[0] === undefined) throw new Error('usage: node tools/compat.mjs snapshot <bin> [--family defaults|all] [--platform win32-x64]')
    commandSnapshot(positional[0], family, option('platform'))
    break
  case 'coverage':
    commandCoverage(positional[0], family, option('platform', PRIMARY_PLATFORM))
    break
  case 'diff':
    if (positional[0] === undefined || positional[1] === undefined) throw new Error('usage: node tools/compat.mjs diff <a.json> <b.json>')
    commandDiff(positional[0], positional[1])
    break
  case 'check':
    commandCheck()
    break
  default:
    console.error('usage: node tools/compat.mjs <packs|snapshot|coverage|diff|check> …')
    process.exit(2)
}
