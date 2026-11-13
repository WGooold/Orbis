# ADR-0073：原生 CLI 启动提示与就绪反馈

日期：2026-11-12

Status: accepted（开始实施；部署和用户验收分别记录）

关联：ADR-0033、0056、0064、0072。

## 问题

原生 CLI 在连接 Orbis 之前可能显示更新、首次设置、账号登录、目录信任或权限确认。启动进程和打开终端不代表原生会话就绪。把这类等待统一当成超时会使手机端无法判断下一步；模拟输入也无法可靠区分更新、授权与退出选项。

## 决策

S57／SC81：Host 发起的原生启动关闭可验证的启动更新检查，继续使用已选择版本。使用单次 argv 或子进程环境配置，保留 Host 的更新入口及原生手动更新。参数集中维护，覆盖新建、恢复及 Host 的本地终端入口；用户自行携带参数调用的 CLI 保持其原意。原生桌面应用与已有外部服务沿用自己的更新管理。

启动准备沿用 ADR-0056 的项目范围授权。Host 发起的 Claude 启动无条件跳过 bypass 首次风险提示：每次通过临时 settings 传入 `skipDangerousModePermissionPrompt=true`，与项目 MCP 设置合并，使用同一启动身份，只启动一次。该参数已通过隔离原生验证；权限模式仍按所选配置启动，跳过提示的设置仅作用于本次进程。

能通过公开只读接口确认的阻塞在开窗前返回具体原因和处理入口。原生登录、OAuth、管理策略和系统权限交由对应授权流程处理。插件加载与真实会话握手确认就绪。未知的握手超时显示“结果未确认”并指向电脑端提示，按 ADR-0072 保留原操作核对及结束等待，不从超时推断某个确认页或自动再次启动。

## 适配清单

| 客户端与情况 | 参数、配置或提醒 | 状态与范围 |
| --- | --- | --- |
| Codex 启动更新询问 | `-c check_for_update_on_startup=false` | 官方 0.167.0 配置和更新实现支持；用于 Host 打开的独立及 remote TUI，保留 `codex update` |
| Claude 后台自更新 | 子进程 `DISABLE_AUTOUPDATER=1` | 官方环境变量；终端脚本显式设置，保留 `claude update`；不设置会禁止手动更新的 `DISABLE_UPDATES` |
| Pi 自身版本通知 | 子进程 `PI_SKIP_VERSION_CHECK=1` | 1.5.0 文档及实现支持；通知原本非阻塞；扩展包更新通知仍可显示，不使用会影响其他网络活动的 `PI_OFFLINE` |
| DeepSeek DSH 更新 | 当前没有确认到阻塞启动的 CLI 更新询问或专属关闭开关 | 0.2.2-rc.1 的 launcher、Web／ACP 与插件更新入口分开；后续出现原生证据再适配 |
| 项目目录信任 | Pi `--approve`、Codex 项目 `trust_level`、Claude 所选目录原生信任 | 已有 ADR-0056；限定用户选择的工作目录 |
| Claude 项目 MCP 初次启用 | 单次 `enabledMcpjsonServers` | 已有实现；仅当前项目具名服务器，保留显式拒绝；OAuth 仍需用户授权 |
| Claude bypass 首次风险提示 | 每次启动无条件传入 `--settings '{"skipDangerousModePermissionPrompt":true}'` | 2.1.318／2.1.322 隔离 TUI 和真实插件已验证；合并到单次临时 settings，按所选权限模式启动 |
| Claude 缺登录 | `auth status --json` 预检，提示连接账号后重试 | 已实现；Host 本地 setup 仍可打开登录流程 |
| Claude 禁用插件、Hooks、安全／简单模式及受管限制 | 启动前报告具体配置名及启用入口 | 已有部分预检；持续核对发行版公开开关，不覆盖用户拒绝或管理策略 |
| Codex 登录／账号选择、组织要求、模型迁移及提示 | 使用原生账号／配置接口报告，终端仍有提示时引导用户检查电脑 | 继续调查具体版本分支；更新开关不等于跳过其他原生提示 |
| Pi 供应商登录、扩展自定义提示、MCP OAuth | 保留原生授权／扩展行为，未握手时提醒检查电脑 | 项目信任开关只处理项目资源；第三方扩展可能在 session_start 前等待，尚无通用跳过参数 |
| 系统终端、钥匙串、网络／防火墙和文件访问授权 | 原生系统界面完成，启动失败显示明确操作提示 | 系统边界；不通过模拟回车或修改授权数据库处理 |
| 无效配置、版本不兼容、服务认证／锁冲突 | 返回配置位置、所需版本或连接错误，保留已有进程 | 不是确认页；修复配置或版本后再按原操作身份核对 |

## 兼容与验证

环境变量对旧端是附加的子进程配置；Codex 配置开关须核对实际发行版解析规则及最近已发布版本。复用真实旧实现与当前版本的同版正对照，确认没有参数解析失败、启动握手回退或会话身份变化。未完成的版本范围单独记录。

回归重点是 macOS Terminal 不继承 Host 环境、Windows 新窗口环境传递、Pi RPC 路径，以及 Codex new／resume／remote 多入口。使用隔离配置、合成终端和原生只读／握手探针，避免真实用户会话与自动更新。实现、自动验证、构建、部署和用户验收分别记录。

### Windows 待验证

以下场景须在真实 Windows 隔离账号／配置中验证。macOS 上生成并检查 PowerShell／cmd 脚本只覆盖脚本构造；当前两项 Windows 原生条件测试跳过，原生开窗与版本组合仍待验证。

| 场景 | 验证要求 | 对应实现／自动用例 |
| --- | --- | --- |
| Codex 新建、恢复与 remote TUI | 覆盖手机启动、Host 本地入口及在线 shim；核对实际 argv、所选 CLI、工作目录、原 sessionId／endpoint、rollout 等待与关闭清理 | `codex-runtime.test.ts`、`desktop-terminal.test.ts`、`codex-shim.test.ts`、`codex-terminal-connection.test.ts` |
| Codex 登录、显式参数与 Host 离线 | `login`、`update`、`--help` 和自带参数仍按原 argv 调用；离线 shim 使用已选原生／npm 安装；启动更新开关只作用于规定的 Host TUI 路径 | `codex-shim.ts`、`desktop-runtime.ts`、`codex-command.test.ts` |
| Pi TUI 与 RPC | 新建／恢复、Host 本地入口均核对原生子进程 `PI_SKIP_VERSION_CHECK=1`；RPC stdin 保持打开，扩展连接及原会话身份正常；父进程环境不被修改 | `spawner.test.ts`、`desktop-terminal.test.ts`、`agent-command.test.ts` |
| Claude 启动、设置合并与清理 | 无条件跳过 bypass 首次提示；核对所选权限、`DISABLE_AUTOUPDATER=1`、单份临时 settings、项目 MCP 显式拒绝、单次开窗与插件握手；配置新建的 `--session-id` 与持久预定 UUID 一致，恢复沿用 `--resume`；正常退出和开窗失败清理临时设置 | `claude-startup.test.ts`、`claude-launcher.test.ts`、`agent-backend.test.ts` |
| Windows 安装形式与路径 | 覆盖原生 `.exe`、npm／pnpm `.cmd` 和已支持的 `.ps1`；工作区、安装路径和配置目录覆盖空格、中文、单引号、`%`、`&`、括号；核对真实 argv、环境和退出码 | `agent-command.test.ts`、`claude-launcher.test.ts`、`windows-console.test.ts` |
| 迟到握手、断线及版本回退 | 按原启动及预定原生身份核对，包含同一 Claude 终端切换原生会话、Host 重启和缺少预定身份的旧记录；最近发版 Host／App／插件与候选版本做真实旧端交叉验证和同版正对照，检查重连、首句仅发送一次及回退 | `host-service.test.ts`、`claude-mods-bridge.test.ts`、`session-configuration-store.test.ts`、ADR-0064、ADR-0072 |

Windows 执行后记录系统、终端、安装方式及实际 CLI 版本，保留命令、握手、退出与清理证据。当前无 Windows 原生通过结论；部署与用户安装验收待完成。

2026-11-13 Windows CI 修复：合并 `cf4ab52` 的 cmd 内嵌引号修复，保留真实 `%*` 参数与 RPC stdin 往返断言；Claude 模拟 POSIX 启动通过用户原生安装目录发现夹具，POSIX npm 布局与 Windows 排除断言分别执行。桌面安装生命周期测试隔离机器注册表／登录 shell 环境刷新，继续核对 DSH 重启完成、供应商同步与准确启动参数；符号链接权限跳过仅限 Windows。相关 8 文件在 macOS 本机 116 项通过、1 项 Windows 原生用例跳过，完整类型检查与定向 lint 通过。首次 Windows CI 的 4 文件／10 项失败、后续验证与边界见 [本次证据](../../.artifacts/windows-ci-20261113/verification.json)。Windows 修复后 CI、部署和用户验收尚未完成。

实现指针：`packages/host/src/agent-startup.ts`、`spawner.ts`、`claude-launcher.ts`、`codex-terminal-macos.ts`、`codex-runtime.ts`、`codex-shim.ts`、`desktop-runtime.ts`、`macos-agent-terminal.ts`。

Claude 首次提示跳过参数的原生证据：`.artifacts/claude-bypass-consent-20261112/verification.json`。本次审查及修复证据：`.artifacts/native-cli-startup-review-20261112/verification.json` 与 `fixes/verification.json`。4 项旧测试断言已按新增启动参数／临时 settings 更新；修复后的相关 Node 用例 540 项通过、2 项 Windows 原生用例跳过，Android 相关单测及原失败复现共 30 项通过。类型与 lint 检查通过，本地化及 plist 沿用同源码静态检查证据。Claude 迟到恢复身份误绑、Android 结束等待遗留发送账本两项回归均已修复，决策与测试指针见 ADR-0072。原始失败证据保留；上述验证范围内未发现剩余回归，Windows 原生及完整跨版本矩阵仍待验证。尚未部署，待用户验证。

## 依据

- Codex 0.167.0 [配置 schema](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/config.schema.json)、[更新提示](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/update_prompt.rs)。
- Claude [环境变量](https://code.claude.com/docs/en/env-vars)、[设置](https://code.claude.com/docs/en/settings)。
- Pi 1.5.0 随包 `docs/environment-variables.md`、`docs/security.md`、`dist/utils/version-check.js` 与 `dist/modes/interactive/interactive-mode.js`。
- DSH 0.2.2-rc.1 随包 launcher help、Web／ACP 类型与插件管理实现。
