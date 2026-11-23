# 安装与验证步骤

本文按顺序列出安装、配置与验证的操作及判据。每一步都有可检查的结果，前一步未通过不要继续。配置项见 [CONFIG.md](CONFIG.md)，行为与边界见 [DETAIL.md](DETAIL.md)。

## 目标状态

安装完成后应满足：

1. Plugins 列表中存在 **Shell 守卫**，`enabled: true`；
2. 就绪检查四项通过：二进制存在、版本 ≥ `minVersion`、无害命令判定 `allow`、必拒命令判定拒绝；
3. 之后每次 `bash` / `pwsh` / `ops_bash` / `ssh_exec` 调用都会在 `%DSH_HOME%\dsh-shell-dcg\audit\<日期>.jsonl` 追加一行；
4. `rm -rf`、`git reset --hard` 一类命令被拒绝，理由中包含 `dcg` 的 `rule_id`。

判定全部来自外部程序 `dcg`。本插件不做模型推理，也不需要联网判定。

## 1. 环境检查

```sh
node --version          # 需要 >= 18
dcg --version           # 不要求成功；成功则记录版本
echo "$DSH_HOME"        # Windows: $env:DSH_HOME；为空时默认 ~/.dsh
```

平台支持：`win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。其他平台需自行编译 `dcg`，再通过 `dcgPath` 指定。

判据：`dcg --version` 返回 ≥ 0.16.0 时跳过第 2 步；返回更低版本时不要沿用，按第 2 步安装。

工具面（本次会话里出现哪些命令工具）在会话创建时确定。刚启用或停用 `pwsh` / `bash` 工具时，需重启 DSH 才会在会话中可见，旧会话不会更新。

## 2. 安装 dcg

三种方式，按可用性选择。

### 2a. 通过插件安装（需在界面操作一次）

安装插件后，进入 **设置 → Shell 守卫**，点击「安装 dcg」。

该动作按 `lib/install.js` 中固定的版本与 SHA-256 下载对应平台资产，校验摘要后解包到 `%DSH_HOME%\dsh-shell-dcg\bin\<版本>\`。摘要不匹配即丢弃，不执行。下载上限 5 分钟。

### 2b. 代码检出中安装

```sh
node tools/install-dcg.mjs
```

同样固定版本并校验摘要。企业网络存在 TLS 拦截时，改用 `node --use-system-ca tools/install-dcg.mjs`。npm 安装的插件包不包含 `tools/`，此方式仅适用于代码检出。

### 2c. 手动安装

1. 从 `dcg` 的 release 页面下载对应平台资产：
   - Windows x64：`dcg-x86_64-pc-windows-msvc.zip`
   - Linux x64：`dcg-x86_64-unknown-linux-musl.tar.xz`
   - macOS arm64：`dcg-aarch64-apple-darwin.tar.xz`
2. 解包并确认版本：

   ```sh
   ./dcg --version
   ```

3. 放置到稳定位置。三种方式，按需选择：

   - `%DSH_HOME%\dsh-shell-dcg\bin\<版本号>\dcg.exe`：插件启动时扫描该目录，按版本号取最新的一个，无需配置。目录名须为版本号，否则排序靠后、界面显示的名称也会是目录名。该目录归插件管理，点「安装 dcg」重装同一版本会覆盖其中的文件。
   - 加入 `PATH`：官方安装脚本的默认做法，插件在没有托管版本时使用它。
   - 任意稳定路径 + `dcgPath` 配置项：最明确，插件不会改动该文件。

   三种方式下手动放入的二进制都不经过插件的 SHA-256 校验，来源需自行确认。不要放在临时目录，也不要依赖项目目录（会随仓库移动或清理而失效）。

不要修改 `~/.config/dcg/config.toml`。插件通过 `--config` 使用自己生成的策略文件，两者互不影响。

## 3. 安装插件

由人操作：在 DSH 侧栏 **插件** 页点 **添加插件**，填入以下任一：

- 包名 `dsh-shell-dcg`（已发布到 npm 时）
- Git 地址 `https://github.com/joonokon/dsh-shell-dcg`
- 本地目录的绝对路径（克隆仓库后）

命令行等价形式：

```sh
dsh plugin add dsh-shell-dcg
```

由 agent 操作时调用工具：

```
plugin_manager { action: "install_bundle", target: "dsh-shell-dcg" }
```

本地目录安装时把 `target` 换成绝对路径。该操作可能需要更高权限或人工确认。

## 4. 启用插件

优先通过设置页：**设置 → Shell 守卫**，打开总开关。插件会重启并执行就绪检查。

若设置页提示该 profile 不支持保存配置，编辑 `%DSH_HOME%\profiles\<profile>\cordis.patch.yml`：

```yaml
- id: dsh-shell-dcg
  name: dsh-shell-dcg
  config:
    enabled: true
    # dcg 不在 PATH 中时才需要：
    # dcgPath: C:\path\to\dcg.exe
```

修改后重启 DSH。

## 5. 验证

### 5.1 dcg 判定能力（仅判定，不执行）

```sh
printf 'git reset --hard HEAD~1' | dcg --robot test --stdin --format json
```

判据：`"decision":"deny"`，`"rule_id":"core.git:reset-hard"`。
若此处返回 `allow`，问题在 `dcg` 而非插件，先修复 `dcg`。

### 5.2 插件就绪状态

设置页中 `dcg` 一栏应显示版本与路径，「检查是否可用」四项（`binary`、`version`、`probe-allow`、`probe-deny`）全部通过。

无界面时读取状态接口（端口取自 DSH Web 界面地址栏）：

```sh
curl -s http://127.0.0.1:<端口>/api/dsh-shell-dcg/status
```

判据：`"enabled": true`，`"binary": { "ok": true, ... }`。非本机来源返回 403，属预期。

### 5.3 门禁接线

执行一条无害命令（如 `echo ok`），然后：

```sh
ls "$DSH_HOME/dsh-shell-dcg/audit/"
```

判据：当天的 `.jsonl` 新增一行，`tool` 为 `ops_bash`，`decision` 为 `allow`。

### 5.4 拦截生效

在没有待丢弃改动的仓库中尝试 `git reset --hard HEAD~1`。

判据：命令被拒绝，理由包含 `core.git:reset-hard`；审计中对应一行为 `decision: deny`。
不要用真实的破坏性命令验证。

## 6. 异常处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 拒绝理由含 `SHELL_DCG_NOT_READY` | 就绪检查未通过 | 理由中已指出未通过项，按项修复 |
| 已设 `enabled: true` 但无记录 | 插件未加载或未重启 | 检查 Plugins 列表状态并重启 DSH |
| 状态接口返回 403 | 请求非本机来源 | 使用 `127.0.0.1`，不要使用局域网地址 |
| 「安装 dcg」报证书错误 | 企业网络 TLS 拦截 | 手动安装（2c），或使用 `--use-system-ca` |
| 下载超时 | 网络或代理 | 手动安装（2c） |
| 误拦比例偏高 | 规则过严 | 先 `policy.defaultMode: warn` 观察，再按包降级 `policy.packModes` |
| 不清楚命中了哪条规则 | — | 拒绝理由含 `rule_id`，`dcg pack info <id>` 可查看说明与严重度 |

## 7. 约束

- 不要通过修改 `~/.config/dcg/config.toml` 使插件生效，插件不读取该文件。
- 不要跳过就绪检查直接启用。默认 `onNotReady: deny`，未就绪会阻断所有命令类工具。
- 不要手动编辑 `%DSH_HOME%\dsh-shell-dcg\generated\policy.toml`，每次启动会重写。
- 不要用真实破坏性命令验证，使用 `dcg test`，它只判定不执行。
- 可将 `onNotReady` 设为 `pass` 临时放行，但该状态下没有保护，需尽快恢复。

## 8. 结果报告

完成后记录：

- 平台与架构、插件版本、`dcg` 版本与路径来源（托管 / 配置 / PATH）
- 就绪检查四项结果
- 审计文件路径与验证期间新增的记录条数
- 是否触发过拒绝，以及对应的 `rule_id`
- 改动过的配置项，特别是 `enabled`、`onNotReady`、`policy.defaultMode`
