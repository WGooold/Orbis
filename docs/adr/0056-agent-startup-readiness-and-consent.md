# ADR-0056：所有 Agent 的启动准备与首次授权

日期：2026-11-01

Status: accepted（实现与验收结果分别记录，设备与原生联动状态见下文）

## 问题

从 App 选择目录并启动 Agent 后，原生终端可能停在项目信任、插件许可、初始化或认证步骤；连接尚未建立，运行时交互转发也尚未可用。Claude 已实际复现，Pi 的项目资源信任同样发生在 session_start 之前。仅修改 Claude 项目信任不能代表其他 Agent 已覆盖。

## 决策

### 1. 统一边界

启动在所选项目与本次操作范围内准备原生配置和 Orbis 集成，账号、工具权限、第三方与系统授权由各自原生流程管理。原生握手及会话响应确认就绪，失败和超时返回明确结果。

### 2. 各后端契约

| 后端 | 项目授权 | 其他首次步骤 / 成功证据 |
| --- | --- | --- |
| Pi | 用户发起启动使用公开 `--approve`，仅本进程有效，TUI/RPC 一致 | Orbis 扩展通过显式 `-e` 加载；账号/MCP OAuth 保留原生授权，loopback ready 后才连接成功 |
| Codex | 使用公开项目 trust_level 配置，限定所选目录；remote TUI 通过 app-server 配置接口处理相同配置上下文 | app-server initialize / thread 响应为准；Desktop 既有账号和组织策略不可冒认，工具交互沿用已有转发 |
| Claude | 沿用 ADR-0033 §14 的项目级信任；启动参数固定实际配置目录；对本次项目 `.mcp.json` 中具名服务器传临时 `enabledMcpjsonServers`，保留显式拒绝 | 启动前读取原生 `auth status --json`，缺登录直接失败；明确的桌面 setup 入口仍允许原生登录。插件禁用 / 已识别管理策略直接报告；其他未知初始化仅能按 hello 截止时间报错 |
| DeepSeek ACP / Web | 通过公开服务 / session API 创建恢复，原生协议入口没有终端目录信任页 | initialize、服务认证和 session 返回为准；工具 / 问卷通过已有 interaction 转发；拒绝或配置缺失明确失败 |

#### 2.1 App 请求会话时按需启动后端

App 会话请求复用就绪后端，按需准备并等待原生握手后执行会话操作；并发准备由同一入口串行复用。agents 表示已就绪，launchableAgents 表示本机可准备的后端，预启动设置控制提前准备。

2026-11-05 DSH 已有服务自动恢复复用 ADR-0020 的接口，启动时和每次完成后 2 秒只读探测已配置服务，显式 App 启动仍可独立确保服务。macOS Claude 启动按 ADR-0033 §18 等待真实 TTY 回执与原生 hello；源码验证与设备验收分别记录。

参考：[ADR-0033 §18](0033-claude-code-tui-mods-integration.md#18-macos-启动脚本执行确认2026-11-03源码验证--未部署)。

### 3. 兼容与失败

目标构建的公开接口与实际配置决定兼容性，准备阶段保持原配置及会话所有权，错误路径清理本次登记与临时资源。新增后端同步维护能力和验证入口。

## UI 关系

沿用 ADR-0051 V12、V16–V18、S16 的真实状态与作用域规则，启动反馈复用已有回执和交互界面。新增交互同步维护协议、两端实现与验证。

## 验证计划

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施与结果

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 依据

- Pi 随目标安装分发的 `docs/cli.md`、`docs/security.md`：`--approve` 仅信任当前进程项目资源。
- Codex 官方配置参考：<https://developers.openai.com/codex/config-reference/>；公开 app-server 协议与本机目标类型。
- Claude 官方权限 / 插件 / 设置参考与 ADR-0033 §14。
- DeepSeek 本机发行包公开 ACP / Web 类型与现有适配器测试。
