/**
 * The Host-side HTTP surface the settings page talks to.
 *
 * A bundle cannot add a Client-callable Remote namespace (that set is fixed when
 * DSH is built), but it can mount routes on the Host web server and let the
 * browser call them, which is how the other third-party panels do it. Four
 * routes, all loopback-only: read status, list the pack catalog, run one action,
 * and write the switch or the policy.
 *
 * @module dsh-shell-dcg/lib/http
 */

import { installManaged } from './install.js'
import { writePolicy } from './policy.js'
import { describeBinary, summarizeAudit } from './status.js'
import { describeDoctorFailure, runDoctor } from './doctor.js'
import { resolveBinary, runDcg } from './dcg.js'

/** Route prefix; the settings page hard-codes the same three paths. */
export const ROUTE_PREFIX = '/api/dsh-shell-dcg'

/**
 * Mount every route on a context that has `webServer`.
 * @param ctx - a context with `webServer` and `logger`.
 * @param settings - normalized plugin settings.
 * @returns the disposer that unmounts them.
 */
export function registerRoutes(ctx, settings) {
  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      auth: 'anonymous',
      handler: (req, res) => guard(req, res, () => status(res, settings)),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/action`,
      auth: 'anonymous',
      handler: (req, res) => guard(req, res, () => action(req, res, settings)),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      auth: 'anonymous',
      handler: (req, res) => guard(req, res, () => config(ctx, req, res, settings)),
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/packs`,
      auth: 'anonymous',
      handler: (req, res) => guard(req, res, () => packs(res, settings)),
    }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A route already unmounted by a reload is not an error worth surfacing.
      }
    }
  }
}

/**
 * Every route is personal-account data: loopback passes, anything else is
 * refused. The Host's own auth story may grow later; until then a LAN browser
 * must not be able to read the audit log or flip the gate off.
 */
function guard(req, res, run) {
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  Promise.resolve()
    .then(run)
    .catch((error) => writeJson(res, 500, { ok: false, error: errorMessage(error) }))
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

async function status(res, settings) {
  const binary = await describeBinary(settings)
  const audit = summarizeAudit(settings)
  writeJson(res, 200, {
    ok: true,
    enabled: settings.enabled,
    binary: {
      path: binary.path ?? null,
      source: binary.source ?? null,
      version: binary.version ?? null,
      ok: binary.ok,
      reason: binary.reason ?? null,
    },
    minVersion: settings.minVersion,
    policy: {
      defaultMode: settings.policy.defaultMode,
      packs: settings.policy.packs,
      packModes: settings.policy.packModes,
    },
    audit: {
      enabled: settings.audit.enabled,
      files: audit.files.length,
      lines: audit.lines,
      keepCommandText: settings.audit.keepCommandText,
      retentionDays: settings.audit.retentionDays,
      retentionEntries: settings.audit.retentionEntries,
      recent: audit.recent.map((record) => ({
        ts: record.ts ?? null,
        tool: record.tool ?? null,
        decision: record.decision ?? record.event ?? null,
        ruleId: record.ruleId ?? null,
        severity: record.severity ?? null,
        ms: record.ms ?? null,
        error: record.error ?? null,
        command: record.command ?? null,
      })),
    },
  })
}

async function action(req, res, settings) {
  const body = await readJson(req)
  const kind = typeof body?.action === 'string' ? body.action : ''
  if (kind === 'doctor') {
    const binary = resolveBinary(settings)
    if (binary.path === undefined) {
      writeJson(res, 200, { ok: false, error: 'dcg 未找到；先安装或设置 dcgPath' })
      return
    }
    const policyFile = writePolicy(settings).path
    const result = await runDoctor({ settings, binary, policyFile, cwd: process.cwd() })
    writeJson(res, 200, {
      ok: result.ok,
      version: result.version ?? null,
      checks: result.checks,
      error: result.ok ? null : describeDoctorFailure(result),
    })
    return
  }
  if (kind === 'install') {
    const result = await installManaged()
    writeJson(res, 200, result.ok ? { ok: true, version: result.version, path: result.path } : { ok: false, error: result.reason })
    return
  }
  writeJson(res, 400, { ok: false, error: `unknown action "${kind}"` })
}

/**
 * The pack catalog, so the settings page can offer real ids instead of a free
 * text field. `dcg packs` ignores `--config`, so the enabled flags here are the
 * machine's own; what matters to the page is which ids this plugin selects.
 */
async function packs(res, settings) {
  const binary = resolveBinary(settings)
  if (binary.path === undefined) {
    writeJson(res, 200, { ok: false, error: 'dcg 未找到', configured: settings.policy.packs, packs: [] })
    return
  }
  const result = await runDcg(binary.path, ['packs', '--format', 'json'], { timeoutMs: settings.timeoutMs })
  if (result.failure !== undefined) {
    writeJson(res, 200, { ok: false, error: result.failure, configured: settings.policy.packs, packs: [] })
    return
  }

  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    writeJson(res, 200, { ok: false, error: 'cannot parse `dcg packs --format json`', configured: settings.policy.packs, packs: [] })
    return
  }

  const configured = settings.policy.packs
  const selects = (id) => configured.some((entry) => entry === id || id.startsWith(`${entry}.`))
  const list = (Array.isArray(parsed.packs) ? parsed.packs : []).map((pack) => ({
    id: pack.id,
    name: pack.name ?? pack.id,
    category: pack.category ?? '',
    selected: selects(pack.id),
    // `dcg packs` has no --config, so this is the machine's own answer, carried
    // only as a hint and never as the plugin's setting.
    enabledOnMachine: pack.enabled === true,
  }))

  writeJson(res, 200, { ok: true, configured, packs: list })
}

async function config(ctx, req, res, settings) {
  const body = await readJson(req)
  const hasEnabled = typeof body?.enabled === 'boolean'
  const policy = pickPolicy(body?.policy)
  const hasPolicy = policy !== undefined
  const audit = pickAudit(body?.audit)
  const hasAudit = audit !== undefined
  if (!hasEnabled && !hasPolicy && !hasAudit) {
    writeJson(res, 400, { ok: false, error: 'send enabled, policy, or audit' })
    return
  }

  const entry = ctx.fiber?.entry
  const editor = ctx.get?.('configEditor')
  if (entry === undefined || editor === undefined) {
    writeJson(res, 409, { ok: false, error: '这个 profile 不支持保存配置；请改 cordis.patch.yml' })
    return
  }
  try {
    await editor.edit(entry, (current) => ({
      ...current,
      ...(hasEnabled ? { enabled: body.enabled } : {}),
      ...(hasPolicy ? { policy: { ...(current.policy ?? {}), ...policy } } : {}),
      ...(hasAudit ? { audit: { ...(current.audit ?? {}), ...audit } } : {}),
    }))
  } catch (error) {
    writeJson(res, 409, { ok: false, error: errorMessage(error) })
    return
  }
  writeJson(res, 200, {
    ok: true,
    enabled: hasEnabled ? body.enabled : settings.enabled,
    policy: hasPolicy ? { ...settings.policy, ...policy } : settings.policy,
    audit: hasAudit ? { ...settings.audit, ...audit } : settings.audit,
  })
}

/** Only the audit keys this plugin understands, and only in the right shapes. */
function pickAudit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const picked = {}
  for (const key of ['enabled', 'keepCommandText']) {
    if (typeof raw[key] === 'boolean') picked[key] = raw[key]
  }
  for (const key of ['retentionDays', 'retentionEntries', 'commandMaxChars']) {
    if (Number.isInteger(raw[key])) picked[key] = raw[key]
  }
  return Object.keys(picked).length > 0 ? picked : undefined
}

/** Only the policy keys this plugin understands, and only in the right shapes. */
function pickPolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const picked = {}
  if (Array.isArray(raw.packs) && raw.packs.every((entry) => typeof entry === 'string')) {
    picked.packs = raw.packs
  }
  for (const key of ['defaultMode', 'observeUntil']) {
    if (typeof raw[key] === 'string') picked[key] = raw[key]
  }
  if (raw.packModes !== null && typeof raw.packModes === 'object' && !Array.isArray(raw.packModes)) {
    picked.packModes = raw.packModes
  }
  return Object.keys(picked).length > 0 ? picked : undefined
}

function readJson(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      // The bodies here are one boolean or one action name; anything larger is a mistake.
      if (text.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(text.length === 0 ? '{}' : text))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
