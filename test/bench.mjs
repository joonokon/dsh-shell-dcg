/**
 * Measure what the gate costs per command.
 *
 *   node test/bench.mjs [--runs 100] [--bin dcg]
 *
 * Every judged call pays one process start plus dcg's own evaluation, because the
 * gate shells out rather than keeping a resident evaluator. This prints the
 * distribution so the overhead is a number instead of a claim.
 *
 * @module dsh-shell-dcg/test/bench
 */

import { spawnSync } from 'node:child_process'
import os from 'node:os'

import { policyPath } from '../lib/config.js'

/** One allowed command, one refused command: the two paths through the gate. */
const CASES = [
  ['allow  ls -la', 'ls -la'],
  ['deny   rm -rf ./build', 'rm -rf ./build'],
  ['deny   git reset --hard', 'git reset --hard HEAD~1'],
]

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const runs = Number.parseInt(option('runs', '100'), 10)
const bin = option('bin', 'dcg')
const policy = policyPath()
const args = ['--robot', 'test', '--stdin', '--format', 'json', '--dialect', 'posix', '--config', policy]

/** Min / median / p90 / max of one sample set, in milliseconds. */
function summarise(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (quantile) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]
  return { min: sorted[0], median: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] }
}

console.log(`bin      ${bin}`)
console.log(`policy   ${policy}`)
console.log(`host     ${os.cpus()[0].model.trim()} / ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB / ${os.platform()} ${os.release()}`)
console.log(`node     ${process.version}`)
console.log('')
console.log('case                          n      min   median      p90      max')

for (const [label, command] of CASES) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint()
    const result = spawnSync(bin, args, { input: command, encoding: 'utf8', timeout: 20_000 })
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    if (result.error !== undefined) {
      console.error(`\n${label}: ${result.error.message}`)
      process.exit(1)
    }
  }
  const stats = summarise(samples)
  console.log(
    `${label.padEnd(26)} ${String(runs).padStart(4)}  ${stats.min.toFixed(1).padStart(6)}  ${stats.median.toFixed(1).padStart(6)}  ${stats.p90.toFixed(1).padStart(6)}  ${stats.max.toFixed(1).padStart(6)}`,
  )
}
