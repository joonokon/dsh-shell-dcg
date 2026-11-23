/**
 * Browser half of dsh-shell-dcg: one Settings page showing what the gate sees.
 *
 * The page talks to the Host through the plugin's own loopback routes rather
 * than a Remote namespace, because a bundle cannot add one. Everything it shows
 * is read fresh on mount and after each action; nothing is polled.
 *
 * Loaded by the Client module table as a lazy factory whose id is the package
 * name, so the id below must stay in step with `package.json`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-shell-dcg',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-shell-dcg'
    const zh = navigator.language.toLowerCase().startsWith('zh')
    const copy = zh
      ? {
          label: 'Shell 守卫',
          subtitle: '每条 shell 命令执行前，先交给 DCG 判断它会不会造成破坏；读写文件这类工具不在它的范围内。',
          loading: '读取中…',
          gate: '总开关',
          severityMode: 'dcg 默认',
          on: '已开启',
          off: '已关闭',
          binary: 'dcg',
          policy: '策略',
          audit: '日志',
          recent: '最近的判定',
          empty: '还没有判定记录',
          doctor: '检查是否可用',
          install: '安装 dcg',
          working: '执行中…',
          downloading: '正在下载并校验，最长 5 分钟…',
          switchedOn: '已开启。插件会重启一次并自检，通过后开始判定。',
          switchedOff: '已关闭。插件重启后不再注册监听。',
          notFound: '未安装',
          noRecords: '无记录',
          lines: (n) => `共 ${n} 条`,
          mode: '判定为危险时',
          modeOptions: [
            ['', 'dcg 默认'],
            ['deny', '一律拒绝'],
            ['ask', '询问'],
            ['warn', '只警告'],
            ['log', '只记录'],
          ],
          modeHints: {
            '': '使用 dcg 自带的分级：严重和高危直接拒绝，中等风险只警告，轻微风险仅记录。推荐。',
            deny: '只要被判为危险就拒绝，不分轻重。最严格，但可能挡住你说得清的常规操作。',
            ask: '弹窗让你决定执不执行。需要审批功能开启；审批关闭时会被自动拒绝。',
            warn: '全部放行，只在日志里记一条警告，适合先观察。',
            log: '全部放行，只记录不警告，等于只看不拦。',
          },
          packs: '额外启用的规则包',
          packsHint: '基础规则（core）始终开启；这里只是增加更多类别，例如 database 覆盖数据库相关命令。',
          packsLoading: '正在读取可用的规则包…',
          packsFailed: '暂时读不到规则包列表，可以直接填写包名；重启 DSH 后这里会变成勾选列表。',
          logs: '最近记录',
          logHint: 'allow 放行 · warn 警告 · deny 拒绝 · ask 等审批',
          savePolicy: '保存策略',
          savedPolicy: '已保存。插件重启后按新策略判定。',
          packsUnit: (n) => `${n} 组`,
          logEnabled: '记录日志',
          clearLog: '清空日志',
          cleared: (n) => `已清空 ${n} 条记录`,
          savedLog: '已保存。',
          retentionDays: '保留天数',
          retentionEntries: '最多条数',
          retentionHint: '超过任一上限就从最旧的记录开始删；清理发生在下次写入时。',
          saveRetention: '保存',
          savedRetention: '已保存。下次写入判定记录时按新上限清理。',
          commandMissing: '（未记录命令）',
        }
      : {
          label: 'Shell guard',
          subtitle: 'Before each shell command runs, DCG decides whether it could do damage. File-editing tools are out of scope.',
          loading: 'Loading…',
          gate: 'Gate',
          severityMode: 'dcg default',
          on: 'On',
          off: 'Off',
          binary: 'dcg',
          policy: 'Policy',
          audit: 'Log',
          recent: 'Recent verdicts',
          empty: 'No verdicts yet',
          doctor: 'Check install',
          install: 'Install dcg',
          working: 'Working…',
          downloading: 'Downloading and verifying, up to 5 minutes…',
          switchedOn: 'On. The plugin restarts and self-checks before judging anything.',
          switchedOff: 'Off. The plugin restarts and installs no listener.',
          notFound: 'not installed',
          noRecords: 'none',
          lines: (n) => `${n} records`,
          mode: 'When a command looks dangerous',
          modeOptions: [
            ['', 'dcg default'],
            ['deny', 'Always deny'],
            ['ask', 'Ask'],
            ['warn', 'Warn only'],
            ['log', 'Log only'],
          ],
          modeHints: {
            '': 'Use the grading dcg ships with: critical and high are denied, medium only warns, low is recorded. Recommended.',
            deny: 'Anything flagged is refused, whatever its severity. Strictest, and it will stop routine work you can explain.',
            ask: 'A prompt asks you to allow or refuse. Needs approvals; with approvals off the command fails closed.',
            warn: 'Everything runs, with a warning in the log. Good for watching first.',
            log: 'Everything runs and is only recorded, never blocked.',
          },
          packs: 'Extra rule packs',
          packsHint: 'The core rules are always on; ticking here only adds categories, e.g. database covers database commands.',
          packsLoading: 'Reading the available packs…',
          packsFailed: 'The pack list is unavailable; type pack names instead. A DSH restart turns this into checkboxes.',
          logs: 'Recent records',
          logHint: 'allow passed · warn warned · deny refused · ask waited for approval',
          savePolicy: 'Save policy',
          savedPolicy: 'Saved. The plugin restarts and judges by the new policy.',
          packsUnit: (n) => `${n} packs`,
          logEnabled: 'Record log',
          clearLog: 'Clear log',
          cleared: (n) => `Cleared ${n} records`,
          savedLog: 'Saved.',
          retentionDays: 'Keep days',
          retentionEntries: 'Max entries',
          retentionHint: 'Past either limit the oldest records go first; trimming happens on the next write.',
          saveRetention: 'Save',
          savedRetention: 'Saved. The next write trims to the new limits.',
          commandMissing: '(command not recorded)',
        }

    // Scoped CSS: the native select could not be themed, so the controls are
    // written out, and hover/focus only exist in a stylesheet.
    const CSS = `
.dsh-dcg { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; padding: 4px 0 24px; }
.dsh-dcg__hint { color: var(--dsw-alias-label-secondary); margin: 0 0 16px; }
.dsh-dcg__title { font-size: 13px; font-weight: 600; margin: 20px 0 8px; }
.dsh-dcg__card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 2px 16px; }
.dsh-dcg__row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dsh-dcg__row:last-child { border-bottom: none; }
.dsh-dcg__key { color: var(--dsw-alias-label-secondary); flex: 0 0 auto; }
.dsh-dcg__value { text-align: right; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dsh-dcg__mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-tertiary); }
.dsh-dcg__btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer; transition: background 120ms ease; }
.dsh-dcg__btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dcg__btn:disabled { opacity: 0.5; cursor: default; }
.dsh-dcg__btn:focus-visible, .dsh-dcg__seg button:focus-visible, .dsh-dcg__disclose:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-dcg__seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; overflow: hidden; }
.dsh-dcg__seg button { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-primary); padding: 5px 10px; font-size: 12px; cursor: pointer; transition: background 120ms ease; }
.dsh-dcg__seg button + button { border-left: 1px solid var(--dsw-alias-border-l1); }
.dsh-dcg__seg button:hover:not([aria-pressed="true"]) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-dcg__seg button[aria-pressed="true"] { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.dsh-dcg__disclose { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; padding: 12px 0; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; cursor: pointer; text-align: left; }
.dsh-dcg__disclose:hover { color: var(--dsw-alias-brand-primary); }
.dsh-dcg__count { color: var(--dsw-alias-label-tertiary); font-weight: 400; }
.dsh-dcg__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 16px; padding: 0 0 14px; }
.dsh-dcg__check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-dcg__check input { accent-color: var(--dsw-alias-brand-primary); }
.dsh-dcg__input { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 10px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsh-dcg__input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-dcg__actions { display: flex; gap: 8px; padding: 12px 0 0; }
.dsh-dcg__log { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; font-size: 12px; }
.dsh-dcg__pill { min-width: 52px; text-align: center; border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dsh-dcg__pill--deny { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dsh-dcg__pill--allow { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dsh-dcg__pill--warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsh-dcg__cmd { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsh-dcg__rule { color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsh-dcg__number { width: 84px; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 8px; font-size: 12px; }
.dsh-dcg__alert { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 10px; padding: 10px 14px; margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; }
.dsh-dcg__info { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 14px; margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; }
.dsh-dcg__detail { color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-top: 4px; }
.dsh-dcg__note { color: var(--dsw-alias-label-secondary); margin: 12px 0 0; }
`

    // ------------------------------------------------------------------- data

    async function request(path, init) {
      const response = await fetch(API + path, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body === undefined) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    /** Categories in the catalog, with how many packs each one covers. */
    function categoriesOf(catalog) {
      const byCategory = new Map()
      for (const pack of catalog) {
        const category = pack.category.length > 0 ? pack.category : pack.id.split('.')[0]
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1)
      }
      return [...byCategory.entries()].sort((left, right) => left[0].localeCompare(right[0]))
    }

    const selectsCategory = (entries, category) =>
      entries.some((entry) => entry === category || entry.startsWith(`${category}.`))

    /** Audit stamps are ISO UTC; the page shows the reader's own clock. */
    const clockOf = (ts) => {
      if (typeof ts !== 'string') return '--:--:--'
      const date = new Date(ts)
      return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString(undefined, { hour12: false })
    }

    const pillClass = (decision) =>
      decision === 'deny' || decision === 'allow' || decision === 'warn'
        ? `dsh-dcg__pill dsh-dcg__pill--${decision}`
        : 'dsh-dcg__pill'

    // -------------------------------------------------------------- component

    /** Nav glyph for the settings section: the same shield-and-prompt as the app icon. */
    function SectionIcon({ size = 16, active = false } = {}) {
      const ink = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M12 3l7 3v6c0 4.6-3 7.6-7 9-4-1.4-7-4.4-7-9V6z',
          fill: 'none',
          stroke: ink,
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M9.2 9.8l2.1 2.1-2.1 2.1',
          fill: 'none',
          stroke: ink,
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M13.2 14h3.2', stroke: ink, strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function Section() {
      const [status, setStatus] = React.useState(undefined)
      const [loadError, setLoadError] = React.useState(undefined)
      const [busy, setBusy] = React.useState(undefined)
      const [outcome, setOutcome] = React.useState(undefined)

      // Policy editing: `undefined` follows the Host, a value is unsaved input.
      const [mode, setMode] = React.useState(undefined)
      const [packs, setPacks] = React.useState(undefined)
      const [retention, setRetention] = React.useState(undefined)
      const [catalog, setCatalog] = React.useState(undefined)
      const [catalogError, setCatalogError] = React.useState(undefined)
      const [showPacks, setShowPacks] = React.useState(false)
      const [showLog, setShowLog] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const next = await request('/status')
          setStatus(next)
          setLoadError(undefined)
          return next
        } catch (failure) {
          setLoadError(failure.message)
          return undefined
        }
      }, [])

      React.useEffect(() => {
        let live = true
        request('/status')
          .then((next) => {
            if (!live) return
            setStatus(next)
            setLoadError(undefined)
          })
          .catch((failure) => {
            if (live) setLoadError(failure.message)
          })
        return () => {
          live = false
        }
      }, [])

      // The catalog is only fetched when the pack list is first opened.
      React.useEffect(() => {
        if (!showPacks || catalog !== undefined) return
        let live = true
        request('/packs')
          .then((result) => {
            if (!live) return
            if (result.ok !== true) setCatalogError(result.error ?? copy.packsFailed)
            else setCatalog(result.packs)
          })
          .catch((failure) => {
            if (live) setCatalogError(failure.message)
          })
        return () => {
          live = false
        }
      }, [showPacks, catalog])

      const run = async (label, path, body, describe) => {
        setBusy(label)
        setOutcome(undefined)
        try {
          const result = await request(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
          if (result.ok === false) {
            setOutcome({ kind: 'error', text: result.error ?? '操作失败', details: detailsOf(result) })
          } else {
            setOutcome({ kind: 'info', text: describe(result), details: detailsOf(result) })
            await load()
          }
          return result
        } catch (failure) {
          setOutcome({ kind: 'error', text: failure.message })
          return undefined
        } finally {
          setBusy(undefined)
        }
      }

      /** Doctor answers with per-check lines; nothing else does. */
      const detailsOf = (result) =>
        Array.isArray(result.checks) ? result.checks.map((entry) => `${entry.ok ? '✓' : '✗'} ${entry.id}: ${entry.detail}`) : []

      const toggle = () =>
        run('toggle', '/config', { enabled: !(status?.enabled ?? false) }, (result) =>
          result.enabled ? copy.switchedOn : copy.switchedOff,
        )

      const savePolicy = async () => {
        const chosen = mode ?? status?.policy.defaultMode ?? ''
        const entries = packs ?? status?.policy.packs ?? []
        const result = await run('save', '/config', { policy: { defaultMode: chosen, packs: entries } }, () => copy.savedPolicy)
        if (result?.ok === true) {
          setMode(undefined)
          setPacks(undefined)
        }
      }

      const saveRetention = async () => {
        const days = retention?.days ?? status?.audit.retentionDays ?? 30
        const entries = retention?.entries ?? status?.audit.retentionEntries ?? 2000
        const result = await run('retention', '/config', { audit: { retentionDays: days, retentionEntries: entries } }, () => copy.savedRetention)
        if (result?.ok === true) setRetention(undefined)
      }

      const toggleLog = async () => {
        await run('log', '/config', { audit: { enabled: !(status?.audit.enabled ?? false) } }, () => copy.savedLog)
      }

      const clearLog = async () => {
        await run('clear', '/action', { action: 'clear-audit' }, (result) => copy.cleared(result.removed))
      }

      const currentPacks = packs ?? status?.policy.packs ?? []
      const togglePack = (category) => {
        const next = selectsCategory(currentPacks, category)
          ? currentPacks.filter((entry) => entry !== category && !entry.startsWith(`${category}.`))
          : [...currentPacks, category]
        setPacks(next)
      }

      if (status === undefined) {
        return h('div', { className: 'dsh-dcg' }, h('p', { className: 'dsh-dcg__hint' }, loadError ?? copy.loading))
      }

      const recent = status.audit.recent ?? []
      const binaryLine =
        status.binary.path === null ? copy.notFound : `dcg ${status.binary.version ?? '?'} · ${status.binary.path}`
      const categories = catalog === undefined ? [] : categoriesOf(catalog)

      const row = (key, value, mono) =>
        h(
          'div',
          { className: 'dsh-dcg__row' },
          h('span', { className: 'dsh-dcg__key' }, key),
          h('span', { className: mono === false ? undefined : 'dsh-dcg__value' }, value),
        )

      return h(
        'div',
        { className: 'dsh-dcg' },
        h('style', null, CSS),
        h('p', { className: 'dsh-dcg__hint' }, copy.subtitle),

        h(
          'div',
          { className: 'dsh-dcg__card' },
          h(
            'div',
            { className: 'dsh-dcg__row' },
            h('span', { className: 'dsh-dcg__key' }, copy.gate),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { className: 'dsh-dcg__key' }, status.enabled ? copy.on : copy.off),
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': status.enabled,
                  'aria-label': copy.label,
                  disabled: busy === 'toggle',
                  onClick: toggle,
                  className: 'dsh-dcg__btn',
                  style: {
                    width: 40,
                    height: 22,
                    padding: 2,
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: status.enabled ? 'flex-end' : 'flex-start',
                    background: status.enabled ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                    borderColor: status.enabled ? 'transparent' : 'var(--dsw-alias-border-l2)',
                  },
                },
                h('span', {
                  style: {
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: status.enabled ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-tertiary)',
                  },
                }),
              ),
            ),
          ),
          row(copy.binary, binaryLine),
          row(copy.policy, status.policy.defaultMode.length > 0 ? `default_mode=${status.policy.defaultMode}` : copy.severityMode),
          row(copy.audit, status.audit.enabled ? copy.lines(status.audit.lines) : copy.noRecords),
        ),

        h('h3', { className: 'dsh-dcg__title' }, copy.policy),
        h(
          'div',
          { className: 'dsh-dcg__card' },
          h(
            'div',
            { className: 'dsh-dcg__row', style: { flexWrap: 'wrap' } },
            h('span', { className: 'dsh-dcg__key' }, copy.mode),
            h(
              'div',
              { className: 'dsh-dcg__seg', role: 'group', 'aria-label': copy.mode },
              ...copy.modeOptions.map(([value, label]) =>
                h(
                  'button',
                  {
                    key: value || 'auto',
                    type: 'button',
                    'aria-pressed': (mode ?? status.policy.defaultMode ?? '') === value,
                    onClick: () => setMode(value),
                  },
                  label,
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsh-dcg__row', style: { borderBottom: 'none', paddingBottom: 0 } },
            h('span', { className: 'dsh-dcg__hint', style: { margin: 0 } },
              copy.modeHints[mode ?? status.policy.defaultMode ?? ''] ?? ''),
          ),
          h(
            'div',
            { className: 'dsh-dcg__row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-dcg__disclose',
                'aria-expanded': showPacks,
                onClick: () => setShowPacks(!showPacks),
              },
              h('span', { style: { width: 10, display: 'inline-block' } }, showPacks ? '▾' : '▸'),
              copy.packs,
              h('span', { className: 'dsh-dcg__count' }, `（${currentPacks.length}）`),
            ),
            showPacks
              ? catalog === undefined
                ? catalogError === undefined
                  ? h('p', { className: 'dsh-dcg__hint', style: { margin: '0 0 12px' } }, copy.packsLoading)
                  : h(
                      'div',
                      { style: { padding: '0 0 12px' } },
                      h('p', { className: 'dsh-dcg__hint', style: { margin: '0 0 4px' } }, copy.packsFailed),
                      h('p', { className: 'dsh-dcg__detail', style: { margin: '0 0 8px' } }, catalogError),
                      // Without the catalog, a text field still allows editing; the
                      // route needs a Host restart to serve the checkbox list.
                      h('input', {
                        type: 'text',
                        className: 'dsh-dcg__input',
                        value: currentPacks.join(', '),
                        placeholder: 'database, containers.docker',
                        onChange: (event) =>
                          setPacks(
                            event.target.value
                              .split(/[,\s]+/)
                              .map((entry) => entry.trim())
                              .filter((entry) => entry.length > 0),
                          ),
                      }),
                    )
                : h(
                    'div',
                    { className: 'dsh-dcg__grid' },
                    ...categories.map(([category, count]) =>
                      h(
                        'label',
                        { key: category, className: 'dsh-dcg__check' },
                        h('input', {
                          type: 'checkbox',
                          checked: selectsCategory(currentPacks, category),
                          onChange: () => togglePack(category),
                        }),
                        category,
                        h('span', { className: 'dsh-dcg__count' }, copy.packsUnit(count)),
                      ),
                    ),
                  )
              : null,
            h('span', { className: 'dsh-dcg__hint', style: { margin: '0 0 12px' } }, copy.packsHint),
          ),
        ),
        h(
          'div',
          { className: 'dsh-dcg__actions' },
          h('button', { type: 'button', className: 'dsh-dcg__btn', disabled: busy !== undefined, onClick: savePolicy },
            busy === 'save' ? copy.working : copy.savePolicy),
          h('button', {
            type: 'button',
            className: 'dsh-dcg__btn',
            disabled: busy !== undefined,
            onClick: () => run('doctor', '/action', { action: 'doctor' }, (result) => (result.ok === true ? `自检通过 · dcg ${result.version}` : '自检未通过')),
          }, busy === 'doctor' ? copy.working : copy.doctor),
          h('button', {
            type: 'button',
            className: 'dsh-dcg__btn',
            disabled: busy !== undefined,
            onClick: () => run('install', '/action', { action: 'install' }, (result) => `已安装 dcg ${result.version}：${result.path}`),
          }, busy === 'install' ? copy.working : copy.install),
        ),
        busy === 'install' ? h('p', { className: 'dsh-dcg__note' }, copy.downloading) : null,
        outcome === undefined
          ? null
          : h(
              'div',
              { role: outcome.kind === 'error' ? 'alert' : 'status', className: outcome.kind === 'error' ? 'dsh-dcg__alert' : 'dsh-dcg__info' },
              h('div', null, outcome.text),
              ...(outcome.details ?? []).map((line, index) => h('div', { key: `d${index}`, className: 'dsh-dcg__detail' }, line)),
            ),

        h(
          'button',
          { type: 'button', className: 'dsh-dcg__disclose dsh-dcg__title', 'aria-expanded': showLog, onClick: () => setShowLog(!showLog) },
          h('span', { style: { width: 10, display: 'inline-block' } }, showLog ? '▾' : '▸'),
          copy.logs,
          h('span', { className: 'dsh-dcg__count' }, copy.lines(status.audit.lines)),
        ),
        showLog
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dsh-dcg__card' },
                h(
                  'div',
                  { className: 'dsh-dcg__row' },
                  h('span', { className: 'dsh-dcg__key' }, copy.logEnabled),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      'aria-checked': status.audit.enabled,
                      'aria-label': copy.logEnabled,
                      disabled: busy === 'log',
                      onClick: toggleLog,
                      className: 'dsh-dcg__btn',
                      style: {
                        width: 40,
                        height: 22,
                        padding: 2,
                        borderRadius: 999,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: status.audit.enabled ? 'flex-end' : 'flex-start',
                        background: status.audit.enabled ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                        borderColor: status.audit.enabled ? 'transparent' : 'var(--dsw-alias-border-l2)',
                      },
                    },
                    h('span', {
                      style: {
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        background: status.audit.enabled ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-tertiary)',
                      },
                    }),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-dcg__row' },
                  h('span', { className: 'dsh-dcg__key' }, copy.retentionDays),
                  h('input', {
                    type: 'number',
                    min: 1,
                    max: 3650,
                    className: 'dsh-dcg__number',
                    value: retention?.days ?? status.audit.retentionDays,
                    onChange: (event) => setRetention({ ...(retention ?? {}), days: Number(event.target.value) }),
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-dcg__row' },
                  h('span', { className: 'dsh-dcg__key' }, copy.retentionEntries),
                  h('input', {
                    type: 'number',
                    min: 10,
                    max: 100000,
                    className: 'dsh-dcg__number',
                    value: retention?.entries ?? status.audit.retentionEntries,
                    onChange: (event) => setRetention({ ...(retention ?? {}), entries: Number(event.target.value) }),
                  }),
                ),
                h(
                  'div',
                  { className: 'dsh-dcg__row', style: { borderBottom: 'none' } },
                  h('span', { className: 'dsh-dcg__hint', style: { margin: 0 } }, copy.retentionHint),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
                    h('button', { type: 'button', className: 'dsh-dcg__btn', disabled: busy !== undefined, onClick: saveRetention },
                      busy === 'retention' ? copy.working : copy.saveRetention),
                    h('button', { type: 'button', className: 'dsh-dcg__btn', disabled: busy !== undefined, onClick: clearLog },
                      busy === 'clear' ? copy.working : copy.clearLog),
                  ),
                ),
              ),
              h('p', { className: 'dsh-dcg__hint', style: { margin: '8px 0' } }, copy.logHint),
              recent.length === 0
                ? h('p', { className: 'dsh-dcg__hint' }, copy.empty)
                : h(
                    'div',
                    { className: 'dsh-dcg__card' },
                    ...recent.map((record, index) =>
                      h(
                        'div',
                        { key: `${record.ts ?? index}-${index}`, className: 'dsh-dcg__log' },
                        h('span', { className: 'dsh-dcg__mono' }, clockOf(record.ts)),
                        h('span', { className: pillClass(record.decision) }, record.decision ?? '?'),
                        h(
                          'span',
                          { className: 'dsh-dcg__cmd', title: record.command ?? record.tool ?? '' },
                          record.command ?? copy.commandMissing,
                        ),
                        record.ruleId === null || record.ruleId === undefined
                          ? null
                          : h('span', { className: 'dsh-dcg__rule' }, record.ruleId),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register({ name: 'settings.section', id: 'dsh-shell-dcg', order: 70, label: copy.label }, Section),
            ),
          'dsh-shell-dcg: settings page',
        )

        // The nav row shows a default glyph without this; its id must equal the
        // section id above.
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section.icon', () =>
              ctx.slots.register({ name: 'settings.section.icon', id: 'dsh-shell-dcg' }, SectionIcon),
            ),
          'dsh-shell-dcg: settings section icon',
        )
      },
    }
  },
})
