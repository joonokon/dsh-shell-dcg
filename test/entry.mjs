/**
 * Entry smoke: the files the Host loader and the Client module table import.
 *
 * `smoke.mjs`, `gate.mjs` and `http.mjs` drive `lib/` directly, so nothing they
 * run would notice a broken `index.js` (wrong `inject`, a throw at apply time)
 * or a `client.js` that no longer registers itself — a broken tarball that every
 * other check would still call green. This file imports exactly what DSH imports
 * and asserts the surface both halves have to expose.
 *
 * Run: node test/entry.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

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

await check('every lib module parses and exports something', async () => {
  const dir = path.join(root, 'lib')
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.js'))
    .sort()
  assert.ok(files.length >= 10, `expected the lib modules on disk, found ${files.length}`)
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href)
    assert.ok(Object.keys(module).length > 0, `lib/${file} exports nothing`)
  }
})

await check('index.js exports the row the Host loader reads', async () => {
  const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)
  assert.equal(plugin.name, pkg.name, 'plugin name must equal the package name')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

await check('client.js registers under the package name and applies', async () => {
  let captured
  const registrations = []

  // The two globals client.js reads. `navigator` already exists in Node 21+ as a
  // getter without a setter, so it is replaced rather than assigned.
  Object.defineProperty(globalThis, 'window', {
    value: { __ModuleLoader__: { load: (spec) => (captured = spec) } },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
    writable: true,
  })

  try {
    await import(pathToFileURL(path.join(root, 'client.js')).href)
    assert.ok(captured, 'client.js did not call window.__ModuleLoader__.load')
    assert.equal(captured.id, pkg.name, 'client id must equal the package name')
    assert.equal(typeof captured.factory, 'function')

    const plugin = captured.factory((id) => {
      assert.equal(id, 'react', `unexpected require(${id})`)
      return { createElement: () => null, Fragment: Symbol('Fragment') }
    })
    assert.deepEqual(plugin.inject, ['slots'])
    assert.equal(typeof plugin.apply, 'function')

    // The Host runs each effect body; the two registrations are the page and its
    // nav-row icon, whose ids must stay equal to the section id (and so to the
    // package name, or the Settings page loses its row).
    plugin.apply({
      effect(body) {
        body()
      },
      slots: {
        inject(name, register) {
          register()
        },
        register(target) {
          registrations.push(target)
          return () => {}
        },
      },
    })
  } finally {
    delete globalThis.window
    delete globalThis.navigator
  }

  const ids = registrations.map((target) => target.id)
  assert.deepEqual(ids, [pkg.name, pkg.name], `registered ${ids.join(',')}`)
  assert.equal(registrations[0].name, 'settings.section')
  assert.equal(registrations[1].name, 'settings.section.icon')
  assert.equal(typeof registrations[0].label, 'string')
})

const failed = results.filter((result) => !result.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`)
if (failed.length > 0) process.exitCode = 1
