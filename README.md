# dsh-shell-dcg

[![badge.svg](https://github.com/joonokon/dsh-shell-dcg/actions/workflows/ci.yml/badge.svg)](https://github.com/joonokon/dsh-shell-dcg/actions/workflows/ci.yml)

将 [Destructive Command Guard](https://github.com/Dicklesworthstone/destructive_command_guard)（`dcg`）接入 DeepSeek Harness 的 shell 命令审核链路：每条命令执行前调用一次 `dcg`，按其判定放行、转交审批或拒绝。

本插件在 Windows 上开发与测试，macOS 与 Linux 未实测。

> [!note]
> **AI 辅助开发**：本插件使用 AI 辅助开发。
>
> 判定逻辑全部来自 `dcg`，本插件不含判断规则、不做模型推理。已知限制见 [docs/DETAIL.md](docs/DETAIL.md)。

## 主要功能

- 在 `tools/pre-execute` 最早阶段拦截，被拒绝的命令不会执行
- 默认判定 `bash`、`pwsh`与 `ops_bash`、`ssh_exec`（第三方插件），按工具选择 POSIX 或 PowerShell 语法
- 设置页提供总开关、策略选择、规则包、日志与 `dcg` 一键安装
- 默认关闭，关闭时不进行任何监听

| 命令 | `dcg` 判定 | 插件结果 |
|---|---|---|
| `ls -la`、`git status` | allow | 执行 |
| `git stash drop` | warn | 执行并记录 |
| `rm -rf ./build`、`chmod -R 777 .` | deny（high） | 拒绝 |
| `git reset --hard`、`git push --force` | deny（critical） | 拒绝 |
| `psql -c "DROP TABLE t"`、`npm publish` | deny（high） | 拒绝 |

规则来自 `dcg`，插件未硬编码任何命令，完整列表见 [docs/DETAIL.md](docs/DETAIL.md)。

不涉及的部分：文件路径边界（DSH 沙箱）、读取凭据后的出网行为、远端主机上实际执行的内容。`dcg` 采用 deny-list，可降低风险，不构成完整防护。

## 安装

> [!hint] Hint
> 交给 AI 执行请使用 [docs/AI-INSTALL.md](docs/AI-INSTALL.md)，包含逐步操作、验证判据与异常处理。

1. **安装 dcg**（≥ 0.16.0）。可在插件装好后于 **设置 → Shell 守卫** 点「安装 dcg」：默认下载 0.17.0、校验 SHA-256 后解包；也可前往 DCG 官方 [下载](https://github.com/Dicklesworthstone/destructive_command_guard/releases/) 页面自行下载，将可执行文件加入环境变量或放入 `%DSH_HOME%\dsh-shell-dcg\bin\<版本号>\`。

   ```sh
   dcg --version     # 需要 >= 0.16.0
   ```

2. **安装插件**：在侧栏 **插件** 页点 **添加插件**，填入 Git 地址 `https://github.com/joonokon/dsh-shell-dcg`，也可选择本地目录。

3. **打开开关**：在 **设置 → Shell 守卫** 打开总开关，插件重启后执行四项就绪检查。
若该 profile 不支持通过设置页保存，在 `cordis.patch.yml` 中写入：

   ```yaml
   - id: dsh-shell-dcg
     name: dsh-shell-dcg
     config:
       enabled: true
   ```

4. **验证**：

   ```sh
   printf 'git reset --hard HEAD~1' | dcg --robot test --stdin --format json   # 应返回 deny
   ```

   随后在设置页「最近记录」或 `%DSH_HOME%\dsh-shell-dcg\audit\` 下应出现新增记录。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/AI-INSTALL.md](docs/AI-INSTALL.md) | 分步安装、验证与异常处理 |
| [docs/CONFIG.md](docs/CONFIG.md) | 全部配置项与示例 |
| [docs/DETAIL.md](docs/DETAIL.md) | 判定映射、实测结果、性能、设置页、常见问题、已知限制 |

## License

MIT © 2026 joonokon
