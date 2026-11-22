/**
 * The Host HTTP routes the settings page calls, driven without a live server.
 *
 * Run: node test/http.mjs
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { ROUTE_PREFIX, registerRoutes } from '../lib/http.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-http-'))
process.env.DSH_HOME = scratch

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push(false)
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

/** Capture the three routes instead of mounting them. */
function mount({ editor } = {}) {
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    fiber: { entry: { id: 'dsh-shell-dcg' } },
    get: (name) => (name === 'configEditor' ? editor : undefined),
  }
  const settings = normalizeConfig({ enabled: true, preferManaged: false, dcgPath: path.join(scratch, 'no-dcg.exe') }).settings
  const dispose = registerRoutes(ctx, settings)
  return { routes, dispose }
}

/** One request/response pair against a mounted route. */
async function call(routes, pathName, { ip = '127.0.0.1', body } = {}) {
  const route = routes.get(`${ROUTE_PREFIX}${pathName}`)
  if (route === undefined) throw new Error(`no route ${pathName}`)

  const req = new EventEmitter()
  req.socket = { remoteAddress: ip }
  setImmediate(() => {
    if (body !== undefined) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body))
    req.emit('end')
  })

  let finish
  const settled = new Promise((resolve) => {
    finish = resolve
  })
  const res = {
    statusCode: 0,
    headers: {},
    payload: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.payload = payload
      finish()
    },
  }

  route.handler(req, res)
  await settled
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.payload) }
}

await check('mounts the routes the page calls', () => {
  const { routes, dispose } = mount()
  assert.deepEqual([...routes.keys()].sort(), [
    `${ROUTE_PREFIX}/action`,
    `${ROUTE_PREFIX}/config`,
    `${ROUTE_PREFIX}/packs`,
    `${ROUTE_PREFIX}/status`,
  ])
  for (const route of routes.values()) {
    assert.equal(route.kind, 'exact')
    assert.equal(route.auth, 'anonymous')
  }
  dispose()
  assert.equal(routes.size, 0)
})

await check('the pack catalog answers even when dcg cannot be asked', async () => {
  const { routes } = mount()
  const { status, json } = await call(routes, '/packs')
  assert.equal(status, 200)
  assert.ok(Array.isArray(json.packs))
  // Either the machine answered with a catalog, or the route reports why not.
  assert.equal(typeof json.ok, 'boolean')
  if (json.ok !== true) assert.equal(typeof json.error, 'string')
})

await check('status answers with the shape the page renders', async () => {
  const { routes } = mount()
  const { status, json } = await call(routes, '/status')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.enabled, true)
  assert.equal(typeof json.binary, 'object')
  assert.equal(json.policy.defaultMode, '')
  assert.equal(typeof json.audit.lines, 'number')
  assert.ok(Array.isArray(json.audit.recent))
  assert.equal(json.headers === undefined, true)
})

await check('status reports recent verdicts newest last', async () => {
  const auditRoot = path.join(scratch, 'dsh-shell-dcg', 'audit')
  fs.mkdirSync(auditRoot, { recursive: true })
  fs.writeFileSync(
    path.join(auditRoot, '2026-11-22.jsonl'),
    [
      JSON.stringify({ ts: '2026-11-22T02:00:00.000Z', tool: 'ops_bash', decision: 'allow' }),
      JSON.stringify({ ts: '2026-11-22T02:00:01.000Z', tool: 'ops_bash', decision: 'deny', ruleId: 'core.git:reset-hard' }),
    ].join('\n'),
    'utf8',
  )
  const { routes } = mount()
  const { json } = await call(routes, '/status')
  assert.equal(json.audit.lines, 2)
  assert.equal(json.audit.recent.length, 2)
  assert.equal(json.audit.recent[1].ruleId, 'core.git:reset-hard')
})

await check('a non-loopback caller is refused on every route', async () => {
  const { routes } = mount()
  for (const pathName of ['/status', '/action', '/config']) {
    const { status, json } = await call(routes, pathName, { ip: '10.1.2.3', body: {} })
    assert.equal(status, 403, pathName)
    assert.match(json.error, /loopback-only/)
  }
})

await check('config refuses a body with nothing it can apply', async () => {
  const { routes } = mount()
  const wrongType = await call(routes, '/config', { body: { enabled: 'yes' } })
  assert.equal(wrongType.status, 400)
  assert.match(wrongType.json.error, /send enabled/)

  const empty = await call(routes, '/config', { body: {} })
  assert.equal(empty.status, 400)

  const badPolicy = await call(routes, '/config', { body: { policy: { packs: 'core.git' } } })
  assert.equal(badPolicy.status, 400)

  const unsupported = await call(routes, '/config', { body: { enabled: true } })
  assert.equal(unsupported.status, 409)
  assert.match(unsupported.json.error, /不支持保存配置/)
})

await check('config writes the switch and the policy through one editor call', async () => {
  const seen = []
  const editor = {
    async edit(entry, change) {
      seen.push(change({ enabled: true, policy: { packs: ['core.git'], defaultMode: 'ask', observeUntil: '', packModes: {} } }))
    },
  }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', {
    body: { enabled: false, policy: { packs: ['core.git', 'database.postgresql'], defaultMode: '' } },
  })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(seen[0], {
    enabled: false,
    policy: { packs: ['core.git', 'database.postgresql'], defaultMode: '', observeUntil: '', packModes: {} },
  })
})

await check('config also writes the log retention limits', async () => {
  const seen = []
  const editor = { async edit(entry, change) { seen.push(change({ enabled: true, audit: { retentionDays: 30 } })) } }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', { body: { audit: { retentionDays: 7, retentionEntries: 500 } } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(seen[0].audit, { retentionDays: 7, retentionEntries: 500 })
})

await check('config surfaces a rejected edit instead of claiming success', async () => {
  const editor = { async edit() { throw new Error('overridden by a higher layer') } }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', { body: { enabled: true } })
  assert.equal(status, 409)
  assert.match(json.error, /overridden/)
})

await check('clear-audit removes the day files and reports the count', async () => {
  const auditRoot = path.join(scratch, 'dsh-shell-dcg', 'audit')
  fs.mkdirSync(auditRoot, { recursive: true })
  fs.writeFileSync(path.join(auditRoot, '2026-11-22.jsonl'), '{"n":1}\n{"n":2}\n', 'utf8')
  fs.writeFileSync(path.join(auditRoot, '2026-11-21.jsonl'), '{"n":3}\n', 'utf8')

  const { routes } = mount()
  const { status, json } = await call(routes, '/action', { body: { action: 'clear-audit' } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.removed, 3)
  assert.deepEqual(fs.readdirSync(auditRoot).filter((name) => name.endsWith('.jsonl')), [])
})

await check('action rejects an unknown verb and reports install failures', async () => {
  const { routes } = mount()
  const unknown = await call(routes, '/action', { body: { action: 'pizza' } })
  assert.equal(unknown.status, 400)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }
  try {
    const failed = await call(routes, '/action', { body: { action: 'install' } })
    assert.equal(failed.status, 200)
    assert.equal(failed.json.ok, false)
    assert.match(failed.json.error, /安装失败|offline|cannot reach/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

await check('malformed JSON bodies are treated as empty, not as a crash', async () => {
  const { routes } = mount()
  const { status, json } = await call(routes, '/config', { body: '{not json' })
  assert.equal(status, 400)
  assert.match(json.error, /send enabled/)
})

fs.rmSync(scratch, { recursive: true, force: true })

const failed = results.filter((ok) => !ok).length
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`)
if (failed > 0) process.exitCode = 1
