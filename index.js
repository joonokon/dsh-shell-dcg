/**
 * dsh-shell-dcg — a DCG-backed command gate for the DeepSeek Harness.
 *
 * The plugin listens on the `tools/pre-execute` waterfall and asks
 * Destructive Command Guard (https://github.com/Dicklesworthstone/destructive_command_guard)
 * about every pending shell command. Allowed calls continue untouched;
 * rejected calls never reach their body.
 *
 * Only the shell surface is judged. File tools stay under the Harness
 * sandbox: this plugin is a semantic gate for command strings, not a
 * sandbox and not a path boundary.
 *
 * @module dsh-shell-dcg
 */

import { normalizeConfig } from './lib/config.js'
import { arm } from './lib/gate.js'
import { log } from './lib/log.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-shell-dcg'

/** Everything `arm()` reads from the Host; absent services leave the row inert. */
export const inject = ['tools']

/**
 * Install the gate for this plugin's effect lifetime.
 * @param ctx - the plugin's Cordis context.
 * @param config - the row's configuration (already validated by the loader when it declares a schema).
 * @returns the disposer that disarms the gate.
 */
export function apply(ctx, config) {
  const { settings, warnings } = normalizeConfig(config)
  for (const warning of warnings) log(ctx, 'warn', `dsh-shell-dcg: ${warning}`)
  return arm(ctx, settings)
}
