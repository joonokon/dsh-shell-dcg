/**
 * Gate wiring test: drives `arm()` against a fake Cordis context.
 *
 * This covers the glue the smoke test cannot reach — listener registration,
 * the generator-style effect, tool filtering, and the not-ready denial — without
 * a real dcg binary. A working binary is required only for the end-to-end path.
 *
 * Run: node test/gate.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import { arm } from '../lib/gate.js'

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    results.push({ name, ok: false })
    process.stdout.write(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** Minimal stand-ins for the Host services the gate touches. */
function createContext() {
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {
        const index = listeners.findIndex((entry) => entry.handler === handler)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(callback) {
      const disposers = []
      const generator = callback()
      const pump = async () => {
        let step = generator.next()
        while (step.done !== true) {
          const value = step.value
          if (typeof value === 'function') disposers.push(value)
          else if (value !== undefined && typeof value.then === 'function') {
            const resolved = await value
            if (typeof resolved === 'function') disposers.push(resolved)
          }
          step = generator.next()
        }
      }
      pump().catch(() => {})
      return () => {
        for (const dispose of disposers.reverse()) dispose?.()
      }
    },
  }
  return { ctx, listeners }
}

/** A file that exists but cannot be executed, so dcg resolution succeeds and its version probe fails. */
function brokenBinary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-gate-'))
  const file = path.join(directory, 'dcg')
  fs.writeFileSync(file, 'not a real binary\n')
  return { file, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

const next = async () => ({ kind: 'allow' })
const bashCall = (command) => ({ name: 'ops_bash', arguments: { command, description: 'x' }, callId: 'call-1' })

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-dcg-home-'))

await check('enabled=false installs no listener at all', async () => {
  const { ctx, listeners } = createContext()
  arm(ctx, normalizeConfig({ enabled: false }).settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(listeners.length, 0)
})

const broken = brokenBinary()

await check('registers one prepended pre-execute listener', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({ enabled: true, dcgPath: broken.file, preferManaged: false }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'tools/pre-execute')
  assert.deepEqual(listeners[0].options, { prepend: true })
})

await check('a tool outside the list passes through untouched', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({ enabled: true, dcgPath: broken.file, preferManaged: false }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  let called = 0
  const outcome = await listeners[0].handler(
    { name: 'write', arguments: { file_path: 'x', content: 'y' }, callId: 'c' },
    async () => {
      called += 1
      return { kind: 'allow' }
    },
  )
  assert.equal(called, 1)
  assert.deepEqual(outcome, { kind: 'allow' })
})

await check('not-ready denies with a distinct error identity by default', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({ enabled: true, dcgPath: broken.file, preferManaged: false }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  let called = 0
  const outcome = await listeners[0].handler(bashCall('ls -la'), async () => {
    called += 1
    return { kind: 'allow' }
  })
  assert.equal(called, 0)
  assert.equal(outcome.kind, 'deny')
  assert.equal(outcome.info.code, 'SHELL_DCG_NOT_READY')
  assert.match(outcome.reason, /fail-closed/)
})

await check('onNotReady=pass lets the call through', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({
    enabled: true,
    dcgPath: broken.file,
    preferManaged: false,
    onNotReady: 'pass',
  }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const outcome = await listeners[0].handler(bashCall('ls -la'), next)
  assert.deepEqual(outcome, { kind: 'allow' })
})

await check('a script_path call is denied without consulting dcg', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({ enabled: true, dcgPath: broken.file, preferManaged: false }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const outcome = await listeners[0].handler(
    { name: 'ops_bash', arguments: { script_path: 'E:\\x.sh', description: 'x' }, callId: 'c' },
    next,
  )
  assert.equal(outcome.kind, 'deny')
  assert.equal(outcome.info.code, 'SHELL_DCG_DENIED')
  assert.match(outcome.reason, /scriptPath/)
})

await check('a call with no command at all passes through', async () => {
  const { ctx, listeners } = createContext()
  const settings = normalizeConfig({ enabled: true, dcgPath: broken.file, preferManaged: false }).settings
  arm(ctx, settings)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const outcome = await listeners[0].handler({ name: 'ops_bash', arguments: {}, callId: 'c' }, next)
  assert.deepEqual(outcome, { kind: 'allow' })
})

broken.cleanup()

const failed = results.filter((result) => !result.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
if (failed.length > 0) process.exitCode = 1
