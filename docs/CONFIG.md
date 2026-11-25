# 配置

配置写在 profile 的 `cordis.patch.yml` 中本插件行的 `config` 下；设置页覆盖其中一部分，其余需手写。非法类型或不在枚举范围内的取值会回退到默认值并记录 warning，插件不会因此加载失败。

## 基本

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关。关闭时不注册任何监听 |
| `dcgPath` | `""` | `dcg` 可执行文件路径；留空则按托管目录 → `PATH` 查找 |
| `preferManaged` | `true` | 为 `true` 时托管安装优先；为 `false` 时忽略托管安装，仅使用 `dcgPath` 与 `PATH` |
| `minVersion` | `"0.16.0"` | 低于此版本视为未就绪 |
| `agentName` | `"dsh"` | 传给 `dcg --agent`，对应策略中的 `[agents.dsh]` |
| `tools` | `["bash","pwsh","ops_bash","ssh_exec"]` | 参与判定的工具名。`bash`、`pwsh` 是 DSH 的工具名：Windows 上 `bash` 通常由 `dsh-gitbash-shell` 这类插件提供 Git Bash，Linux 与 macOS 上由 DSH 自带的 `tool-bash` 提供；`ops_bash` 来自 `dsh-ops`，`ssh_exec` 来自 `@linxin666/dsh-ssh`。未安装的工具只是匹配不到，不影响运行 |
| `matchUnlistedTools` | `true` | 工具名不在 `tools` 里、但参数带有 `command` 或 `script_path` 时是否也判定。第三方 shell 插件的工具名无法预先枚举 |
| `commandField` | `"command"` | 提取命令字符串的参数名 |
| `scriptPathField` | `"script_path"` | 提取脚本路径的参数名 |
| `scriptPath` | `"read"` | 仅提供脚本路径时：`read` 读取内容后判定 / `deny` 直接拒绝 / `pass` 不判定 |
| `workdirField` | `"workdir"` | 解析相对脚本路径时使用的 cwd 参数 |
| `dialects` | 按工具映射 | `bash`、`ops_bash`、`ssh_exec` → `posix`；`pwsh` → `ps` |
| `defaultDialect` | `"posix"` | 工具未在 `dialects` 中时的回退值 |
| `timeoutMs` | `3000` | 单次判定超时（毫秒） |
| `maxConcurrent` | `4` | 并发判定上限 |

## 判定落点

| 键 | 默认 | 说明 |
|---|---|---|
| `policy.defaultMode` | `""` | 写入 `[policy] default_mode`，取值 `deny`/`ask`/`warn`/`log`。留空表示不写，采用 `dcg` 的严重度分级 |
| `onAsk` | `"ask"` | `dcg` 判定 `ask` 时：`ask` / `deny` / `allow` |
| `onWarn` | `"allow"` | `dcg` 判定 `warn` 或 `log` 时：`allow` / `ask` / `deny` |
| `failClosed` | `true` | 无法判定时是否拒绝 |
| `onNotReady` | `"deny"` | `dcg` 未就绪时，命令类工具是否拒绝 |
| `crossCheckDialects` | `"on-allow"` | 判定为 `allow` 时，用另一种方言再判一次并取更严的结果；`never` 关闭复核。设置页的「方言复核」即此项 |
| `dryRun` | `false` | 只记录不拦截。与 `policy.defaultMode: log` 效果重叠，区别是不改动策略文件 |

## 规则包与日志

| 键 | 默认 | 说明 |
|---|---|---|
| `policy.packs` | `["database", "package_managers"]` | 额外启用的规则包，写入 `[packs] enabled`。该设置为增量，`core.*` 始终生效。默认值就是 README 判定表里那两行的依据（`psql … DROP TABLE`、`npm publish`）；容器、云、K8s 等其余包默认关闭 |
| `policy.packModes` | `{}` | 单个规则包降级，例如 `{ "core.git": "warn" }` |
| `policy.observeUntil` | `""` | 写入 `policy.observe_until`，`dcg` 内建的灰度到期日 |
| `audit.enabled` | `true` | 是否写入判定记录 |
| `audit.record` | `"warn"` | 最低写入等级，取值 `allow` / `warn` / `ask` / `deny`。低于它的判定不写文件。默认 `warn`：放行的命令远多于被拦的，全记会把拒绝挤出 `retentionEntries` |
| `audit.decisions` | `["warn","ask","deny"]` | 设置页「显示的等级」勾选项。空数组是合法值，表示什么都不显示 |
| `audit.limit` | `20` | 设置页「显示条数」，只能是 `20` / `50` / `100` |
| `audit.keepCommandText` | `true` | 是否记录命令原文；关闭后仅记录哈希 |
| `audit.commandMaxChars` | `300` | 命令原文截断长度 |
| `audit.retentionDays` | `30` | 保留天数 |
| `audit.retentionEntries` | `500` | 最多保留条数。超过任一上限时从最旧记录开始删除，清理发生在下次写入时 |

## 示例

```yaml
- id: dsh-shell-dcg
  name: dsh-shell-dcg
  config:
    enabled: true
    dcgPath: C:\Users\me\bin\dcg.exe
    tools: [bash, pwsh, ops_bash]
    policy:
      packs: [database, kubernetes]
      packModes:
        core.git: warn
    audit:
      record: warn
      decisions: [warn, deny]
      keepCommandText: false
      retentionDays: 7
```

## 说明

- `policy.defaultMode` 留空与显式取值的区别：留空时 `dcg` 按严重度分级（critical / high 拒绝，medium 警告，low 仅记录）；显式填写会把所有等级压成同一动作。
- `policy.packs` 是增量设置：写入的包是额外启用，不是替换 `dcg` 自带的包集合。
- `onNotReady` 处理启动阶段的静态检查失败，`failClosed` 处理单次判定中途失败，两者独立。
- `scriptPath` 仅在调用未提供 `command` 时生效；提供 `command` 时始终优先判定命令字符串。
- `matchUnlistedTools` 覆盖「工具名不在 `tools` 里」的调用。这类调用的方言未知，按 `defaultDialect` 判定，再靠 `crossCheckDialects` 复核另一种方言。
- `crossCheckDialects` 只在判定为 `allow` 时触发。拒绝路径只跑一次 `dcg`，放行路径跑两次，单次判定开销约翻倍。
- 复核那次如果超时或出错，以第一次结果为准，只在日志里留一条 warn——复核是额外一层，不应变成随机拒绝的来源。
- 设置页未提供 `policy.packModes`、`policy.observeUntil`、`dryRun`、`maxConcurrent` 的界面入口，需手写配置。
- 记录等级与显示过滤共用一套四级顺序：`allow < warn < ask < deny`，衡量的是「需要人介入的程度」，不是 `dcg` 的 severity。`dcg` 的 `log` 归入 `allow`（存储时仍是 `log`），`indeterminate` 归入 `deny`（`failClosed` 时它确实被拒绝）。`audit.record` 只影响写入，`audit.decisions` 只影响显示，两者独立。
- `GET /api/dsh-shell-dcg/status` 额外接受 `?limit=20|50|100` 与 `?decisions=warn,deny`，用于不写配置地预览一段切片；非法值回退到配置值，`?decisions=`（空）表示什么都不显示。
