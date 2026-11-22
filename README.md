# dsh-shell-dcg

把 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)（`dcg`）接进 DeepSeek Harness 的工具审核链路：每条 shell 命令执行前先判一次，危险的直接拦住。

面向用户的说明在 [docs/DETAIL.md](docs/DETAIL.md)（也是 Plugins 详情页的内容）。这里是开发笔记。

## 状态

M1：门禁内核 + 就绪自检 + 审计。**没有客户端界面**，开关通过行配置的 `enabled` 控制。开关默认关，装上去不改任何行为。

## 目录

```
index.js              apply / inject / name
lib/config.js         默认值、校验、路径推导
lib/dcg.js            二进制解析、spawn、判定解析、并发限流
lib/policy.js         由配置生成 DCG_CONFIG 指向的 policy.toml
lib/doctor.js         就绪自检（版本 + 两条探针）
lib/audit.js          按天 JSONL 审计
lib/gate.js           tools/pre-execute 门禁本体
locale/*.json         Plugins 页的标题/描述
docs/DETAIL.md        详情页
test/smoke.mjs        纯 Node 冒烟测试（无需 DSH 运行时）
```

## 开发

```sh
node test/smoke.mjs        # 语法 + 纯函数 + 进程层
```

安装到 profile（用绝对路径）：

```
plugin_manager { action: "install_bundle", target: "E:\\Documents\\scripts\\dsh-bash-dcg" }
```

## 几个刻意的决定

**为什么走 `dcg test --stdin` 而不是 `dcg hook`。**
dcg 的 hook 入口会按 `tool_name` 白名单过滤，`ops_bash` 不在名单里，于是它"没有意见"，命令直接放行——静默失效。`test --stdin` 不经过工具名判定，我们把命令喂进去就行；命令走 stdin 也避开了 Windows 的引号和命令行长度问题。

**为什么自己拥有策略文件。**
`--config` 指向插件生成的 `policy.toml`，只写用户真正配置过的键。这样 Harness 会话内的策略和你终端里的 `~/.config/dcg/config.toml` 互不干扰，而且 pin 在一个可复现的文件上。留空时 dcg 用它自己的默认值——"跟随上游"最省事的方式。

**为什么零外部依赖。**
本机安装是 link 到源码目录，Node 会按真实路径解析裸模块名，`@deepseek-ai/*` 不一定能解析到。只用 `node:*` 内建模块就没有这个风险，代价是配置不走 schemastery 表单、需要自己校验（见 `lib/config.js`，它在类型不对时回退并给出 warning，从不抛）。

**为什么未知判定词一律拒绝。**
dcg 的判定词表在演进（`indeterminate` 是后加的）。插件必须"不懂就拦"，否则上游加一个新词就等于开了一个洞。

**为什么失败要 fail closed。**
沙箱侧是 fail closed 的（`SANDBOX_UNAVAILABLE` 而不是无约束地跑）。门禁侧如果悄悄放行，"以为有保护"会比"没有保护"更危险。
