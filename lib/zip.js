/**
 * Just enough ZIP to pull a binary out of a release archive.
 *
 * Node ships `zlib` but no ZIP reader, and shelling out to `unzip`/`tar` would
 * add an external dependency to the one code path that handles a downloaded
 * executable. Reading the central directory and inflating one entry is a small,
 * testable amount of work, so this module does it directly.
 *
 * Scope is deliberately narrow: stored and deflated entries, no ZIP64, no
 * encryption, no CRC validation (the archive's SHA-256 is verified before this
 * runs, which covers integrity).
 *
 * @module dsh-shell-dcg/lib/zip
 */

import zlib from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
const METHOD_STORED = 0
const METHOD_DEFLATE = 8

/**
 * List the entries of a ZIP archive.
 * @returns `{ ok: true, entries }` or `{ ok: false, reason }`.
 */
export function listEntries(buffer) {
  const eocd = findEndRecord(buffer)
  if (eocd === undefined) return { ok: false, reason: 'no end-of-central-directory record' }

  const total = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset + directorySize > buffer.length) {
    return { ok: false, reason: 'central directory points outside the archive' }
  }

  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < total; index += 1) {
    if (cursor + CENTRAL_SIZE > buffer.length) return { ok: false, reason: 'truncated central directory' }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return { ok: false, reason: 'bad central directory signature' }
    }

    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + CENTRAL_SIZE, cursor + CENTRAL_SIZE + nameLength)

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return { ok: false, reason: 'ZIP64 archives are not supported' }
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    cursor += CENTRAL_SIZE + nameLength + extraLength + commentLength
  }

  return { ok: true, entries }
}

/**
 * Read one entry's bytes.
 * @returns `{ ok: true, data }` or `{ ok: false, reason }`.
 */
export function readEntry(buffer, entry) {
  const local = entry.localOffset
  if (local + LOCAL_SIZE > buffer.length) return { ok: false, reason: `${entry.name}: truncated local header` }
  if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    return { ok: false, reason: `${entry.name}: bad local header signature` }
  }
  const start = local + LOCAL_SIZE + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
  const end = start + entry.compressedSize
  if (end > buffer.length) return { ok: false, reason: `${entry.name}: data runs past the archive` }
  const raw = buffer.subarray(start, end)

  if (entry.method === METHOD_STORED) return { ok: true, data: Buffer.from(raw) }
  if (entry.method !== METHOD_DEFLATE) {
    return { ok: false, reason: `${entry.name}: unsupported compression method ${entry.method}` }
  }
  try {
    return { ok: true, data: zlib.inflateRawSync(raw) }
  } catch (error) {
    return { ok: false, reason: `${entry.name}: cannot inflate (${errorMessage(error)})` }
  }
}

/**
 * Find and read the first entry whose basename matches one of `names`.
 * @returns `{ ok: true, name, data }` or `{ ok: false, reason }`.
 */
export function extractNamed(buffer, names) {
  const listed = listEntries(buffer)
  if (listed.ok !== true) return listed

  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const match = listed.entries.find((entry) => {
    const base = entry.name.split('/').pop() ?? ''
    return wanted.has(base.toLowerCase())
  })
  if (match === undefined) {
    const seen = listed.entries.map((entry) => entry.name).join(', ')
    return { ok: false, reason: `no ${names.join('/')} in the archive (has: ${seen})` }
  }

  const read = readEntry(buffer, match)
  if (read.ok !== true) return read
  return { ok: true, name: match.name, data: read.data }
}

function findEndRecord(buffer) {
  // The comment that may follow the record is at most 64 KiB.
  const earliest = Math.max(0, buffer.length - EOCD_SIZE - 0xffff)
  for (let offset = buffer.length - EOCD_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return undefined
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
