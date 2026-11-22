/**
 * Installing a pinned dcg release without trusting the network at run time.
 *
 * The version and the per-target SHA-256 are baked into this file. A download is
 * only unpacked after its digest matches that table, so a compromised or
 * re-published release asset cannot turn into an executed binary. Upgrading means
 * editing this table, which is the point: the gate must not silently follow
 * whatever upstream published this morning.
 *
 * @module dsh-shell-dcg/lib/install
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { managedBinDir } from './config.js'
import { extractNamed } from './zip.js'

/** The one release this build knows how to install. */
export const PINNED_VERSION = '0.17.0'

/** Release assets and digests, taken from that release's own SHA256SUMS. */
export const TARGETS = Object.freeze({
  'win32-x64': Object.freeze({
    asset: 'dcg-x86_64-pc-windows-msvc.zip',
    sha256: '3bcbdb30066f7fa5e1bd3dcb39f27bd353b98d4acdb1ea6694966e400dce1a98',
  }),
  'win32-arm64': Object.freeze({
    asset: 'dcg-aarch64-pc-windows-msvc.zip',
    sha256: 'b5c39871615510a8d16a4791f2355cf04877e057bf460ce7d2269f4502521973',
  }),
  'linux-x64': Object.freeze({
    asset: 'dcg-x86_64-unknown-linux-musl.tar.xz',
    sha256: '5040fd95bba68a6152445d71e682b2da4e5076ca4f51961468a2c77a26fef95a',
  }),
  'linux-arm64': Object.freeze({
    asset: 'dcg-aarch64-unknown-linux-gnu.tar.xz',
    sha256: '6fe9214843806b856da785256e6ee632e8878043bddab61aa27bfecf05bed17d',
  }),
  'darwin-x64': Object.freeze({
    asset: 'dcg-x86_64-apple-darwin.tar.xz',
    sha256: '2842016c1914f0f4c715647976814d0574bb02e55b1aef8e65509c66e75476d5',
  }),
  'darwin-arm64': Object.freeze({
    asset: 'dcg-aarch64-apple-darwin.tar.xz',
    sha256: '90dcfc55c4c9f4a5d9485baf51a5ba61dd53eb152a2980e5a297828ec37f5628',
  }),
})

/** Cap on a download; the largest real asset is under 10 MiB. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** A download must finish in this window; a stalled link is an error, not a wait. */
const DOWNLOAD_TIMEOUT_MS = 300_000
/** Names the binary may carry inside an archive. */
const BINARY_NAMES = process.platform === 'win32' ? ['dcg.exe', 'dcg'] : ['dcg', 'dcg.exe']

/**
 * The pinned asset for one platform.
 * @returns `{ asset, sha256 }`, or `undefined` when this platform is not covered.
 */
export function targetFor(platform = process.platform, arch = process.arch) {
  return TARGETS[`${platform}-${arch}`]
}

/** Where one release asset is downloaded from. */
export function releaseUrl(version, asset) {
  return `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v${version}/${asset}`
}

/** Hex SHA-256 of a buffer. */
export function digestOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Install the pinned dcg release into this plugin's managed directory.
 * @param options.env - environment providing `DSH_HOME`.
 * @param options.fetchImpl - fetch implementation (defaults to the global one).
 * @param options.platform - defaults to the running platform.
 * @param options.arch - defaults to the running arch.
 * @param options.version - defaults to {@link PINNED_VERSION}.
 * @returns `{ ok: true, path, version, bytes }` or `{ ok: false, reason }`.
 */
export async function installManaged(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const version = options.version ?? PINNED_VERSION

  const target = targetFor(platform, arch)
  if (target === undefined) {
    return { ok: false, reason: `no pinned dcg build for ${platform}-${arch}; set dcgPath instead` }
  }

  const url = releaseUrl(version, target.asset)
  const download = await downloadArchive(
    url,
    options.fetchImpl ?? globalThis.fetch,
    options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    options.onProgress,
  )
  if (download.ok !== true) return download

  const digest = digestOf(download.data)
  if (digest !== target.sha256) {
    return { ok: false, reason: `checksum mismatch for ${target.asset}: got ${digest}, expected ${target.sha256}` }
  }

  const binary = unpack(download.data, target.asset, env)
  if (binary.ok !== true) return binary

  const name = platform === 'win32' ? 'dcg.exe' : 'dcg'
  const directory = path.join(managedBinDir(env), version)
  const finalPath = path.join(directory, name)
  try {
    fs.mkdirSync(directory, { recursive: true })
    const temporary = `${finalPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, binary.data, { mode: 0o755 })
    fs.renameSync(temporary, finalPath)
    if (platform !== 'win32') fs.chmodSync(finalPath, 0o755)
  } catch (error) {
    return { ok: false, reason: `cannot write ${finalPath}: ${errorMessage(error)}` }
  }

  return { ok: true, path: finalPath, version, bytes: binary.data.length }
}

/** Download with a size cap, a hard deadline, and byte progress. */
async function downloadArchive(url, fetchImpl, timeoutMs, onProgress) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no fetch implementation available' }

  let received = 0
  const track = (bytes) => {
    received = bytes
    if (typeof onProgress === 'function') onProgress(bytes)
  }
  const giveUp = () => ({
    ok: false,
    reason:
      `download gave up after ${timeoutMs} ms (${formatBytes(received)} received): this link is too slow. ` +
      `Fetch ${url} yourself and point dcgPath at the binary instead.`,
  })

  let response
  try {
    // A slow link is an error, not something to wait out; the deadline is the point.
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    response = await fetchImpl(url, signal === undefined ? undefined : { signal })
  } catch (error) {
    if (isTimeout(error)) return giveUp()
    return { ok: false, reason: `cannot reach ${url}: ${fetchFailure(error)}` }
  }
  if (response.ok !== true) return { ok: false, reason: `${url} answered ${response.status}` }

  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    return { ok: false, reason: `archive is ${declared} bytes, over the ${MAX_ARCHIVE_BYTES}-byte cap` }
  }

  try {
    const data = await readBody(response, track)
    return { ok: true, data }
  } catch (error) {
    if (isTimeout(error)) return giveUp()
    return { ok: false, reason: `cannot read the response body: ${errorMessage(error)}` }
  }
}

/**
 * Read the response, streaming when the body supports it so a slow link can
 * report progress and an oversized archive is stopped early.
 */
async function readBody(response, onProgress) {
  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error(`archive is ${data.length} bytes, over the ${MAX_ARCHIVE_BYTES}-byte cap`)
    return data
  }

  const reader = body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    const chunk = Buffer.from(value)
    total += chunk.length
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel()
      throw new Error(`archive is over the ${MAX_ARCHIVE_BYTES}-byte cap`)
    }
    chunks.push(chunk)
    if (typeof onProgress === 'function') onProgress(total)
  }
  return Buffer.concat(chunks, total)
}

/**
 * Pull the binary out of an archive.
 *
 * `.zip` is read in-process. `.tar.xz` needs `tar`, because Node has no LZMA
 * decoder; that path is only reached on Linux and macOS, where tar is present.
 */
function unpack(data, asset, env) {
  if (asset.endsWith('.zip')) {
    const extracted = extractNamed(data, BINARY_NAMES)
    if (extracted.ok !== true) return { ok: false, reason: extracted.reason }
    return { ok: true, data: extracted.data }
  }
  if (!asset.endsWith('.tar.xz')) return { ok: false, reason: `unsupported archive type: ${asset}` }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-tar-'))
  try {
    const archive = path.join(scratch, path.basename(asset))
    fs.writeFileSync(archive, data)
    const run = spawnSync('tar', ['-xJf', archive, '-C', scratch], { encoding: 'utf8' })
    if (run.error !== undefined) {
      return { ok: false, reason: `tar is required to unpack ${asset}: ${errorMessage(run.error)}` }
    }
    if (run.status !== 0) {
      return { ok: false, reason: `tar failed (${String(run.status)}): ${(run.stderr ?? '').trim()}` }
    }
    for (const name of BINARY_NAMES) {
      const candidate = path.join(scratch, name)
      if (fs.existsSync(candidate)) return { ok: true, data: fs.readFileSync(candidate) }
    }
    return { ok: false, reason: `no ${BINARY_NAMES.join('/')} at the root of ${asset}` }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Node reports nearly every network failure as "fetch failed", with the real
 * reason nested in `cause`. A TLS interceptor surfaces there and deserves its own
 * hint, because the fix is on the host rather than in this plugin.
 */
function fetchFailure(error) {
  const cause = error?.cause === undefined ? '' : ` (${errorMessage(error.cause)})`
  const detail = `${errorMessage(error)}${cause}`
  if (!/certificate|self-signed|unable to verify|CERT_/i.test(detail)) return detail
  return `${detail}; the host cannot verify the TLS chain — run Node with --use-system-ca, or point NODE_EXTRA_CA_CERTS at the signing root`
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
