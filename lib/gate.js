/**
 * The gate itself: one prepended `tools/pre-execute` listener.
 *
 * Order of work per call:
 *   1. is this tool judged at all?            -> otherwise `next()`
 *   2. extract the command text               -> otherwise `next()`
 *   3. boot once (binary, version, policy, doctor), then evaluate
 *   4. map dcg's decision onto a Harness decision
 *
 * Everything is wrapped so an unexpected throw degrades to the configured
 * fail-closed behaviour instead of escaping into the tool pipeline.
 *
 * @module dsh-shell-dcg/lib/gate
 */

import { createHash } from 'node:crypto'

import { compareVersions, extractCommand, otherDialect, planJudgment } from './config.js'
import { createLimiter, readVersion, resolveBinary, testCommand } from './dcg.js'
import { readScript, resolveScriptTarget } from './script.js'
import { writePolicy } from './policy.js'
import { createAudit } from './audit.js'
import { describeDoctorFailure, runDoctor } from './doctor.js'
import { log } from './log.js'

/** Structured error identity persisted with a denial, mirroring the Host's error records. */
const DENIED_NAME = 'ShellDcgDeniedError'
const DENIED_CODE = 'SHELL_DCG_DENIED'
/** Distinct identity for "the guard could not answer", so callers can tell the two apart. */
const NOT_READY_NAME = 'ShellDcgNotReadyError'
const NOT_READY_CODE = 'SHELL_DCG_NOT_READY'
/** Bound on model-facing reason text. */
const REASON_LIMIT = 1200

/**
 * Install the gate for this plugin's effect lifetime.
 * @param ctx - the plugin's Cordis context.
 * @param settings - normalized settings from `normalizeConfig`.
 * @returns the disposer that disarms the gate.
 */
export function arm(ctx, settings) {
  if (!settings.enabled) {
    ctx.logger?.info?.('dsh-shell-dcg: enabled=false — the gate is not installed')
    return
  }

  const audit = createAudit(settings)
  const limit = createLimiter(settings.maxConcurrent)
  const state = {
    accepting: true,
    booted: undefined,
    armed: false,
    failure: undefined,
    binary: undefined,
    version: undefined,
    policyFile: undefined,
    inflight: new Set(),
  }

  /**
   * Boot exactly once. A failed boot is cached: retrying a missing binary on
   * every tool call would add latency without changing the outcome.
   */
  function boot() {
    if (state.booted === undefined) state.booted = doBoot()
    return state.booted
  }

  async function doBoot() {
    const binary = resolveBinary(settings)
    state.binary = binary
    if (typeof binary.path !== 'string' || binary.path.length === 0) {
      state.failure = 'no dcg executable found (install dcg, set dcgPath, or run the one-click install)'
      return
    }
    const { version, reason } = await readVersion(binary.path)
    if (version === undefined) {
      state.failure = reason ?? 'dcg did not report a version'
      return
    }
    state.version = version
    if (compareVersions(version, settings.minVersion) < 0) {
      state.failure = `dcg ${version} is older than the required ${settings.minVersion}`
      return
    }
    try {
      state.policyFile = writePolicy(settings).path
    } catch (error) {
      state.failure = `cannot write the generated policy: ${errorMessage(error)}`
      return
    }
    const doctor = await runDoctor({
      settings,
      binary,
      policyFile: state.policyFile,
      cwd: process.cwd(),
    })
    if (!doctor.ok) {
      state.failure = describeDoctorFailure(doctor)
      return
    }
    state.armed = true
    log(
      ctx,
      'info',
      `dsh-shell-dcg: armed with dcg ${version} at ${binary.path} (policy: ${state.policyFile})`,
    )
  }

  /**
   * One tool call's worth of work.
   * @returns `null` when the call may proceed, or a Harness decision to return.
   */
  async function evaluate(exec, command, scriptTarget, plan) {
    await boot()
    if (!state.armed) {
      audit.record({
        event: 'not-ready',
        session: sessionIdOf(exec),
        tool: exec.name,
        failure: state.failure,
      })
      log(ctx, 'error', `dsh-shell-dcg: not ready — ${state.failure ?? 'unknown reason'}`)
      if (settings.onNotReady === 'pass') return null
      return denied(
        `Shell 守卫未能就绪，已按 fail-closed 策略拒绝这条命令：${state.failure ?? '未知原因'}。` +
          '修复 dcg（安装/升级/修正 dcgPath）后重试，或把插件开关关掉。',
        NOT_READY_NAME,
        NOT_READY_CODE,
      )
    }

    const started = Date.now()
    const judge = (dialect) =>
      testCommand({
        bin: state.binary.path,
        command,
        cwd: sessionCwd(exec),
        dialect,
        policyPath: state.policyFile,
        agentName: settings.agentName,
        timeoutMs: settings.timeoutMs,
      })

    let result = await judge(plan.dialect)
    let viaDialect = plan.dialect
    let crossCheck

    // A tool whose name and executor disagree (a `pwsh` tool that runs bash)
    // gets the wrong grammar, and a parse that finds nothing is exactly the
    // case worth reading twice. Only allows are re-judged: a refusal already
    // stops the command, and this keeps the extra pass off that path.
    if (
      result.ok === true &&
      result.verdict.decision === 'allow' &&
      settings.crossCheckDialects === 'on-allow'
    ) {
      const dialect = otherDialect(plan.dialect)
      const second = await judge(dialect)
      if (second.ok !== true) {
        // The first opinion stands. A second parse that cannot answer says
        // nothing about the command, and denying on it would turn cross-checking
        // into a source of random failures.
        log(ctx, 'warn', `dsh-shell-dcg: cross-check under ${dialect} failed — ${second.reason}`)
        crossCheck = { dialect, error: second.reason }
      } else {
        const chosen = stricterVerdict(result.verdict, second.verdict)
        crossCheck = { dialect, decision: second.verdict.decision, ruleId: second.verdict.rule_id }
        if (chosen === second.verdict) {
          result = second
          viaDialect = dialect
        }
      }
    }
    const elapsed = Date.now() - started

    audit.record({
      event: 'decision',
      session: sessionIdOf(exec),
      tool: exec.name,
      matchedBy: plan.source,
      callId: exec.callId,
      nested: exec.parent !== undefined,
      ...identity(settings, exec, command),
      ...(scriptTarget === undefined ? {} : { script: scriptTarget }),
      ...(result.ok
        ? {
            dialect: viaDialect,
            decision: result.verdict.decision,
            ruleId: result.verdict.rule_id,
            packId: result.verdict.pack_id,
            severity: result.verdict.severity,
          }
        : { error: result.reason }),
      ...(crossCheck === undefined ? {} : { crossCheck }),
      ms: elapsed,
      dcg: state.version,
      dryRun: settings.dryRun || undefined,
    })

    if (!result.ok) {
      log(ctx, 'warn', `dsh-shell-dcg: ${result.reason}`)
      // A policy file dcg refuses to load says nothing about the command, and
      // `failClosed: false` must not launder it into an allow.
      if (result.configError === true) {
        return denied(
          `${result.reason}。这不是命令命中了规则，而是门禁自身的策略文件有问题；修好之前一律拒绝。`,
          NOT_READY_NAME,
          NOT_READY_CODE,
        )
      }
      return settings.failClosed
        ? denied(
            `DCG 无法判定这条命令（${result.reason}），已按 fail-closed 策略拒绝。`,
            NOT_READY_NAME,
            NOT_READY_CODE,
          )
        : null
    }

    // Say so when the refusal came from the second reading: the tool's own
    // dialect allowed the command, and only the cross-check caught it.
    const reason =
      viaDialect === plan.dialect
        ? reasonFor(result.verdict, state.version)
        : `${reasonFor(result.verdict, state.version)}（按 ${viaDialect} 语法复核时命中）`

    const action = mapDecision(result.verdict.decision, settings)
    if (action === 'allow') return null
    if (action === 'ask') {
      return { kind: 'ask', reason }
    }
    return denied(reason, DENIED_NAME, DENIED_CODE)
  }

  /** The waterfall listener. */
  async function listener(exec, next) {
    if (!state.accepting) return { kind: 'cancel' }
    const plan = planJudgment(settings, exec.name, exec.arguments)
    if (plan === undefined) return next()

    const extracted = extractCommand(settings, exec.arguments)
    if (extracted === undefined) return next()

    let command = extracted
    let scriptTarget
    if (typeof extracted === 'object') {
      // A script file carries no command string, so read the file and judge its
      // text: dcg parses shell either way, and that text is what bash will run.
      if (settings.scriptPath === 'pass') return next()

      const target = resolveScriptTarget(extracted.scriptPath, workdirOf(settings, exec), sessionCwd(exec))
      if (settings.scriptPath === 'deny') {
        audit.record({
          event: 'script-path',
          session: sessionIdOf(exec),
          tool: exec.name,
          callId: exec.callId,
          scriptPath: extracted.scriptPath,
          resolved: target,
        })
        return denied(
          `DCG 不读脚本文件 ${target} 的内容，已按配置拒绝。` +
            '改用 command 形式执行，或把 scriptPath 设为 read。',
          DENIED_NAME,
          DENIED_CODE,
        )
      }

      const read = readScript(target)
      audit.record({
        event: 'script-path',
        session: sessionIdOf(exec),
        tool: exec.name,
        callId: exec.callId,
        scriptPath: extracted.scriptPath,
        resolved: target,
        ...(read.ok ? { bytes: read.bytes } : { error: read.reason }),
      })
      if (!read.ok) {
        log(ctx, 'warn', `dsh-shell-dcg: cannot judge ${target} — ${read.reason}`)
        return denied(
          `DCG 无法把脚本 ${target} 读成可判定的 shell 文本（${read.reason}），已按 fail-closed 拒绝。` +
            '可以让调用改用 command 形式，或把 scriptPath 设为 pass 自行承担风险。',
          DENIED_NAME,
          DENIED_CODE,
        )
      }
      command = read.text
      scriptTarget = target
    }

    const task = limit(() => evaluate(exec, command, scriptTarget, plan))
    state.inflight.add(task)
    let outcome
    try {
      outcome = await task.catch((error) => {
        log(ctx, 'error', `dsh-shell-dcg: evaluation failed — ${errorMessage(error)}`)
        return settings.failClosed
          ? denied(`DCG 门禁内部错误（${errorMessage(error)}），已按 fail-closed 策略拒绝。`, NOT_READY_NAME, NOT_READY_CODE)
          : null
      })
    } finally {
      state.inflight.delete(task)
    }
    if (!state.accepting) return { kind: 'cancel' }
    if (outcome === null) return next()
    return outcome
  }

  return ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', listener, { prepend: true })
    yield async () => {
      // Stop admitting new calls, then let in-flight evaluations settle so a
      // disarm cannot leave a half-open gate behind.
      state.accepting = false
      await Promise.allSettled([...state.inflight])
    }
  }, 'dsh-shell-dcg gate')
}

/** How far each dcg decision stops the command; used to pick the stricter of two. */
const DECISION_RANK = Object.freeze({ allow: 0, log: 1, warn: 2, ask: 3, deny: 4, indeterminate: 4 })

/**
 * The stricter of two verdicts from different dialects.
 * @returns `second` when it stops the command harder than `primary`, else `primary`.
 */
export function stricterVerdict(primary, second) {
  const rank = (verdict) => DECISION_RANK[verdict.decision] ?? 4
  return rank(second) > rank(primary) ? second : primary
}

/** Map a dcg decision onto the action the gate takes. */
export function mapDecision(decision, settings) {
  switch (decision) {
    case 'allow':
      return 'allow'
    case 'deny':
      return 'deny'
    case 'ask':
      return settings.onAsk
    case 'warn':
    case 'log':
      return settings.onWarn
    default:
      // `indeterminate` and anything unrecognized: the guard could not conclude.
      return settings.failClosed ? 'deny' : 'allow'
  }
}

/** Model-facing explanation: what matched, why, and which rule to look up. */
export function reasonFor(verdict, version) {
  const detail = firstString(verdict.reason, verdict.explanation) ?? 'matched a destructive-command rule'
  const rule = typeof verdict.rule_id === 'string' && verdict.rule_id.length > 0 ? ` [${verdict.rule_id}]` : ''
  const severity = typeof verdict.severity === 'string' && verdict.severity.length > 0 ? ` (${verdict.severity})` : ''
  const tail = typeof version === 'string' && version.length > 0 ? ` — dcg ${version}` : ''
  return truncate(`DCG blocked this command${severity}: ${detail}${rule}${tail}`, REASON_LIMIT)
}

function denied(reason, name, code) {
  return { kind: 'deny', reason, info: { name, code, reason } }
}

/** Session workspace, so path-scoped allowlists and `.dcg.toml` discovery match the real cwd. */
function sessionCwd(exec) {
  const cwd = exec.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** The call's own `workdir` argument, when it has one. */
function workdirOf(settings, exec) {
  const value = exec.arguments?.[settings.workdirField]
  return typeof value === 'string' ? value : undefined
}

function sessionIdOf(exec) {
  const session = exec.agent?.session
  const id = session?.id ?? session?.header?.id
  return typeof id === 'string' ? id : ''
}

/** Audit identity: the command itself, cut to the configured limit, or only a hash. */
function identity(settings, exec, command) {
  if (settings.audit.keepCommandText) {
    const limit = settings.audit.commandMaxChars
    return {
      command: command.length <= limit ? command : `${command.slice(0, limit)}…`,
      commandLength: command.length,
    }
  }
  return {
    commandHash: createHash('sha256').update(command).digest('hex').slice(0, 16),
    commandLength: command.length,
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
