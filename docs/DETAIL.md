# DCG 命令门禁

把 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)（`dcg`）插进 DSH 的工具审核链路：**每条 shell 命令在执行前先用 dcg 判一次**，被拒绝的命令根本不会跑到 body。

开关默认**关闭**。关着的时候插件不注册任何监听，行为和你没装它完全一致。

## 它做什么

- 在 `tools/pre-execute` 上抢在最前面，取出待执行工具的命令字符串；
- 调 `dcg --robot test --stdin --format json`，把命令从 stdin 喂进去，拿回结构化判定；
- 按判定决定放行、拒绝，或者把决定权交回审批流程；
- 每次判定写一行审计，方便事后回答"昨天它拦了什么"。

覆盖的工具默认是：`ops_bash`、`bash`、`pwsh`、`ssh_exec`。用 `tools` 配置项可以增删。

## 它不做什么

**它不是沙箱，也不管文件路径。** 文件工具（`write`、`edit`、原生文件操作）完全不在它的视野里，那部分归 DSH 的文件沙箱管。它只回答一个问题：*这条命令字符串是不是已知的危险动作*。

所以正确的配合是：

| 层 | 管什么 | 由谁负责 |
|---|---|---|
| 路径边界 | 能写哪里 | DSH 沙箱（`sandbox/mode`） |
| 命令语义 | 边界内做的这件事危不危险 | 本插件 + dcg |
| 事后恢复 | 漏掉的那次怎么回滚 | 检查点 / rewind 一类插件 |

另外两个它看不见的地方，需要提前知道：

- **读 + 出网**。`cat ~/.ssh/id_rsa | curl -d @- ...` 里的读和发都不在 dcg 的判定范围内。
- **远端执行**。`ssh_exec` 的命令串会被判，但 dcg 用的是本地路径语义，基于本地路径的 allowlist 对远端不成立。

## 准备工作：先装 dcg

插件不联网，第一次使用需要本机已有 `dcg`（**≥ 0.16.0**）。三种来源，优先级从高到低：

1. 插件自己托管的版本：`$DSH_HOME/dsh-shell-dcg/bin/<版本>/dcg.exe`
2. 配置项 `dcgPath` 指定的路径
3. 系统 `PATH` 里的 `dcg`

官方安装方式见 dcg 仓库的 `install.ps1`（Windows，带 minisign 校验）或 `install.sh`。

## 打开开关

装配完成后，把这一行的 `enabled` 改成 `true`，重启会话即生效：

```yaml
- id: dsh-shell-dcg
  name: dsh-shell-dcg
  config:
    enabled: true
```

插件启动时会做一次就绪检查：二进制存在、版本够新、生成的策略文件能被 dcg 接受、一条必拒命令仍被判为危险、一条无害命令仍被判为放行。全部通过才算"已武装"。

## 判定怎么映射

dcg 的判定 → DSH 的决定：

| dcg 判定 | 默认动作 | 配置项 |
|---|---|---|
| `allow` | 放行 | — |
| `deny` | 拒绝，理由里带规则 id 和解释 | — |
| `ask` | 交给审批流程：审批策略是 `ask` 就弹给人，是 `never` 就自动拒绝 | `onAsk` |
| `warn` / `log` | 放行（仍记审计） | `onWarn` |
| `indeterminate` | 拒绝（分析没做完，不能当放行） | `failClosed` |
| 未知的新判定词 | 拒绝 | `failClosed` |
| dcg 超时 / 崩溃 / 输出不是 JSON | 拒绝 | `failClosed` |
| dcg 拒绝加载策略（`configuration_error`） | 拒绝，且不受 `failClosed` 影响 | — |

**未知判定词默认拒绝**是刻意的：dcg 以后新增判定词时，插件必须先"不懂就拦"，而不是把它当成放行。

## 失败时的行为

- `onNotReady: "deny"`（默认）：dcg 装坏/找不到时，命令类工具会被拒绝，理由直接写明哪里不对。宁可卡一次，也不要你以为有保护其实没有。
- `onNotReady: "pass"`：不拦，只记审计和日志。适合先把插件装上但不影响工作。

`failClosed: false` 会把上面所有"判不了"的情况都改成放行——只建议在灰度期这么用。唯一例外是策略文件加载失败：那说明门禁自己坏了，这种情况下 `failClosed: false` 也不放行。

## 设置页面

装好并重启 DSH 后，**设置 → 命令门禁** 里有一页：

- 总开关（`role="switch"`）：直接改 `enabled`，走 DSH 的 config editor
- dcg：版本、路径、来源（managed / config / path）
- 策略：「判定为危险时」的动作（dcg 默认 / 一律拒绝 / 询问 / 只警告 / 只记录），每项都有一句说明；下面是按分类勾选的「额外启用的规则包」，默认收起
- 判定记录：累计条数
- 最近的判定：默认收起，展开后是时间、判定、工具与规则 id
- 三个动作：保存策略、检查是否可用、安装 dcg

数据来自插件自己的四条 loopback 路由（`/api/dsh-shell-dcg/status|packs|action|config`）。之所以不用 Remote 命名空间，是因为 bundle 无法在运行期新增一个（那组能力在构建时就定死了）；非本机请求一律 403。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。关掉时完全不注册监听 |
| `dcgPath` | `""` | 指定 dcg 可执行文件；留空则按托管目录 / PATH 查找 |
| `preferManaged` | `true` | 托管版本优先于 `dcgPath` |
| `minVersion` | `"0.16.0"` | 低于此版本视为未就绪 |
| `agentName` | `"dsh"` | 传给 `dcg --agent`，对应策略里的 `[agents.dsh]` |
| `tools` | `["ops_bash","bash","pwsh","ssh_exec"]` | 参与判定的工具名 |
| `commandField` | `"command"` | 从工具参数里取命令的字段名 |
| `scriptPath` | `"read"` | 只给 `script_path` 时：`read` 读出文件内容交给 dcg 判 / `deny` 直接拒 / `pass` 放行不审 |
| `workdirField` | `"workdir"` | 解析相对脚本路径时用哪个参数当 cwd |
| `dialects` | 按工具名映射 | `ops_bash`/`bash`/`ssh_exec` → `posix`，`pwsh` → `ps` |
| `onAsk` | `"ask"` | `ask` / `deny` / `allow` |
| `onWarn` | `"allow"` | `allow` / `ask` / `deny` |
| `failClosed` | `true` | 判不了时是否拒绝 |
| `onNotReady` | `"deny"` | 未就绪时是否拒绝命令类工具 |
| `dryRun` | `false` | 只记录不拦（灰度用） |
| `timeoutMs` | `3000` | 单次判定预算 |
| `maxConcurrent` | `4` | 并发判定上限，防止批量调用 fork 风暴 |
| `policy.packs` | `[]` | 额外启用的包，写进 `[packs] enabled`。这是**增量**的：dcg 自带的包集合照旧生效，`core.*` 始终在保护范围内 |
| `policy.defaultMode` | `""` | 写进 `[policy] default_mode`，取值 `deny`/`ask`/`warn`/`log`。**留空表示不写**，交给 dcg 的严重度分级 |
| `policy.observeUntil` | `""` | 写进 `policy.observe_until`，即 dcg 内建的灰度到期日 |
| `policy.packModes` | `{}` | 单包降级，例如 `{ "core.git": "warn" }` |
| `audit.enabled` | `true` | 是否写审计 |
| `audit.keepCommandText` | `false` | 审计里存命令原文（默认只存哈希） |
| `audit.retentionDays` | `30` | 审计保留天数 |

## 安装 dcg

插件不打包二进制。三条路：dcg 官方安装脚本、自己编译、或者用本插件自带的安装脚本：

```sh
npm run install-dcg
```

它只认 `lib/install.js` 里写死的版本与 SHA-256（当前 0.17.0）。下载后先算摘要，对不上就丢弃，绝不落盘执行——所以升级 dcg 是改这张表、重新发版的动作，而不是运行时跟随上游最新。

- 下载预算 5 分钟，超时立刻报错并提示手动下载，不会挂着不动
- Windows 解包走内置 ZIP 读取器；Linux / macOS 是 `.tar.xz`，用系统 `tar` 解
- 装好的二进制在 `bin/<版本>/`，查找顺序里排在 `dcgPath` 与 PATH 之前

## 关于 dcg 的几点实测结论

**不设 `default_mode` 时，dcg 按严重度分级。** 规则命中后：`critical`/`high` 拒绝、`medium` 警告后放行、`low` 只记日志。插件只在 `policy.defaultMode` 明确配置时才写这一行——把模式定死会把三级压成同一个答案，那才是"模棱两可"的来源。

**终端和会话用的不是同一份配置。** 插件用 `--config` 指定自己生成的策略文件；你在终端直接跑 `dcg` 时读的是 `~/.config/dcg/config.toml`。两边的包集合与 `default_mode` 互不影响，想让会话和终端一致，就把包列表写进 `policy.packs`。

**包是增量的。** `[packs] enabled` 只追加，`core.*` 始终生效；dcg 另有 `[packs] disabled` 可关掉非 core 的包，本插件暂未暴露这个开关。

## 磁盘上有什么

```
$DSH_HOME/dsh-shell-dcg/
  bin/<版本>/dcg.exe        托管安装的二进制（可选）
  generated/policy.toml     由配置生成的 dcg 策略，勿手改
  audit/YYYY-MM-DD.jsonl    每日判定记录
```

策略文件通过 `--config` 传给 dcg，所以**终端里直接跑 `dcg` 仍然用你自己的 `~/.config/dcg/config.toml`**，两边的策略互不干扰。

## 已知限制

- 只判命令字符串。`script_path` 形式会把文件内容读出来再判，上限 256 KB，且必须是可读的 shell 文本：含 NUL 字节、超限、空文件一律拒绝。
- 读文件与 bash 真正执行之间有一个极短的时间窗，脚本在这期间被改写的话判定结果会过期。
- 不判文件工具，不做路径约束。
- dcg 是 deny-list：没被收录的新型破坏写法可能漏过，它也会被刻意构造的混淆绕过。它是减速带，不是保险柜。
- 审计默认只存命令哈希；要复盘具体命令，把 `audit.keepCommandText` 打开。
