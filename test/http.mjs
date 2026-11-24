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
  const [routePath, query] = pathName.split('?')
  const route = routes.get(`${ROUTE_PREFIX}${routePath}`)
  if (route === undefined) throw new Error(`no route ${routePath}`)

  const req = new EventEmitter()
  req.url = query === undefined ? routePath : `${routePath}?${query}`
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

/** Replace the audit directory with exactly these records in one day file. */
function seedAudit(lines) {
  const root = path.join(scratch, 'dsh-shell-dcg', 'audit')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, '2026-11-23.jsonl'), `${lines.join('\n')}\n`, 'utf8')
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
  assert.equal(json.crossCheckDialects, 'on-allow')
  assert.equal(typeof json.audit.lines, 'number')
  assert.ok(Array.isArray(json.audit.recent))
  assert.equal(json.headers === undefined, true)
})

await check('status lists the selected levels only, newest last', async () => {
  const auditRoot = path.join(scratch, 'dsh-shell-dcg', 'audit')
  fs.mkdirSync(auditRoot, { recursive: true })
  fs.writeFileSync(
    path.join(auditRoot, '2026-11-22.jsonl'),
    [
      JSON.stringify({ ts: '2026-11-22T02:00:00.000Z', tool: 'ops_bash', decision: 'allow' }),
      JSON.stringify({ ts: '2026-11-22T02:00:01.000Z', tool: 'ops_bash', decision: 'warn', ruleId: 'core.git:stash-drop' }),
      JSON.stringify({ ts: '2026-11-22T02:00:02.000Z', tool: 'ops_bash', decision: 'deny', ruleId: 'core.git:reset-hard' }),
    ].join('\n'),
    'utf8',
  )
  const { routes } = mount()
  const { json } = await call(routes, '/status')
  // The count covers every level; only the listed ones reach the page.
  assert.equal(json.audit.lines, 3)
  assert.deepEqual(json.audit.recent.map((record) => record.decision), ['warn', 'deny'])
  assert.deepEqual(json.audit.decisions, ['warn', 'ask', 'deny'])
  assert.equal(json.audit.record, 'warn')
  assert.equal(json.audit.limit, 20)
})

await check('a limit and a filter answer from the newest record backwards', async () => {
  const rows = []
  for (let index = 0; index < 30; index += 1) {
    rows.push(
      JSON.stringify({
        ts: `2026-11-23T00:00:${String(index).padStart(2, '0')}.000Z`,
        tool: 'ops_bash',
        event: 'decision',
        decision: index % 2 === 0 ? 'deny' : 'allow',
        ruleId: `rule.${index}`,
      }),
    )
  }
  seedAudit(rows)
  const { routes } = mount()

  // The limit caps the merged list, so the newest 20 records come back whole.
  const capped = await call(routes, '/status?decisions=allow,deny&limit=20')
  assert.equal(capped.json.audit.recent.length, 20)
  assert.equal(capped.json.audit.recent[19].ruleId, 'rule.29')

  // Filter first, then cut: the file holds 15 denials and none are elided.
  const denials = await call(routes, '/status?decisions=deny')
  assert.equal(denials.json.audit.recent.length, 15)
  assert.ok(denials.json.audit.recent.every((record) => record.decision === 'deny'))
  assert.equal(denials.json.audit.recent[14].ruleId, 'rule.28')

  // Present but empty means "show nothing", not "show the default".
  const none = await call(routes, '/status?decisions=')
  assert.deepEqual(none.json.audit.decisions, [])
  assert.deepEqual(none.json.audit.recent, [])

  const fallback = await call(routes, '/status?limit=7&decisions=nonsense')
  assert.equal(fallback.json.audit.limit, 20, 'an off-menu limit keeps the stored one')
  assert.deepEqual(fallback.json.audit.decisions, ['warn', 'ask', 'deny'])
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

await check('config writes the record threshold, the filter and the count', async () => {
  const seen = []
  const editor = { async edit(entry, change) { seen.push(change({ enabled: true, audit: { enabled: true } })) } }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', {
    body: { audit: { record: 'deny', decisions: ['deny', 'warn'], limit: 50 } },
  })
  assert.equal(status, 200)
  // The editor merges over what is stored, so the fake's own keys come along.
  assert.deepEqual(seen[0].audit, { enabled: true, record: 'deny', decisions: ['warn', 'deny'], limit: 50 })
  assert.equal(json.audit.record, 'deny')
  assert.deepEqual(json.audit.decisions, ['warn', 'deny'])
  assert.equal(json.audit.limit, 50)
})

await check('config refuses a level or a count the page cannot render', async () => {
  const editor = { async edit() { throw new Error('the editor must not be reached') } }
  const { routes } = mount({ editor })
  for (const body of [{ audit: { record: 'block' } }, { audit: { limit: 500 } }, { audit: { decisions: [1, 2] } }]) {
    const { status } = await call(routes, '/config', { body })
    assert.equal(status, 400, JSON.stringify(body))
  }
})

await check('config writes the dialect cross-check choice', async () => {
  const seen = []
  const editor = { async edit(entry, change) { seen.push(change({ enabled: true, crossCheckDialects: 'on-allow' })) } }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', { body: { crossCheckDialects: 'never' } })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(seen[0], { enabled: true, crossCheckDialects: 'never' })
  assert.equal(json.crossCheckDialects, 'never')
})

await check('config refuses an unknown cross-check value', async () => {
  const editor = { async edit() { throw new Error('the editor must not be reached') } }
  const { routes } = mount({ editor })
  const { status, json } = await call(routes, '/config', { body: { crossCheckDialects: 'always' } })
  assert.equal(status, 400)
  assert.match(json.error, /on-allow/)
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
  // Start from a known slate: earlier checks left their own day files behind.
  fs.rmSync(auditRoot, { recursive: true, force: true })
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
