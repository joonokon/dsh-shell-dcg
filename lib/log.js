/**
 * One diagnostic sink for the plugin.
 *
 * Diagnostics must never be the reason a tool call fails: a logger that throws,
 * or a Host that composes none, is silently tolerated here. Calls are also made
 * with an explicit receiver so a detached method still works.
 *
 * @module dsh-shell-dcg/lib/log
 */

/**
 * Emit one message through the Host logger when it has that level.
 * @param ctx - the plugin's Cordis context.
 * @param level - `info`, `warn`, or `error`.
 * @param message - the line to emit.
 */
export function log(ctx, level, message) {
  try {
    const logger = ctx?.logger
    if (logger === undefined || logger === null) return
    const sink = logger[level]
    if (typeof sink !== 'function') return
    sink.call(logger, message)
  } catch {
    // A diagnostic is best-effort by definition.
  }
}
