# Claude Code Mods 最新版兼容性验证

2026-10-26，针对 [ADR-0033](../../docs/adr/0033-claude-code-tui-mods-integration.md) 完成第一轮公开 API 验证。使用用户当前 Claude Code 供应商配置，真实模型回复、插件提交、忙碌时排队和停止当前回合通过；完整 Orbis 接入尚未实现。Mods 自身没有已验证的既有请求 resolver；进一步核对官方 Hooks 文档后确认，传统 `PermissionRequest` 和 `PreToolUse` hooks 可分别处理工具审批与 `AskUserQuestion` 答案。该 Hook 路径还没有在本机 v2.1.310 真实 TUI 中运行验收。Channels 是另一条独立工具审批 relay，具体适用条件见下文。

本目录是独立验证插件，不包含 Host backend、认证通道或 App 接入，也没有修改 `packages/*/src`。它只在任务自己的官方 TUI 中运行。此次按用户要求只验证最新版，没有验收 ADR §2 要求的最低版本 v2.1.287，也没有修改该版本要求。

## 环境与证据范围

| 项目 | 本次记录 |
| --- | --- |
| 操作系统与 Node | Windows PowerShell；`C:\nvm4w\nodejs\node.exe` |
| 仓库基线 | `0095613`，独立 WorkTree |
| CLI / `$.session.version()` | `2.1.310` / `{ version: "2.1.310", base: "2.1.310", builtAt: "2026-10-23T17:43:32Z" }` |
| 正式版本依据 | [v2.1.310 Release](https://github.com/anthropics/claude-code/releases/tag/v2.1.310)，公开时间 `2026-10-23T23:39:00Z` |
| 供应商配置 | 沿用用户现有配置；`$.session.model()` 返回 `gpt-6.1-sol`；未修改供应商 URL、密钥或权限规则 |
| 生成类型 | `.claude-plugin/types/claude-code/index.d.ts`，664209 字节；由目标 CLI 加载插件后生成 |
| 类型 SHA-256 | `95BD52583669D28E8FEFB0675FE48630A4F7CC42A1D3EE22AA445D7998A45334` |

类型声明、原生运行观察、testing kit 模拟结果分别记录。类型中的保证不等于已完成对应运行测试。CLI 对当前自定义模型 ID 显示未知模型警告，并按 200k 上下文处理；这没有阻止下述真实回复。没有证据表明该警告导致了工具调用测试的结果。

早先以空 `CLAUDE_CONFIG_DIR` 启动的隔离配置尝试在插件加载前遇到 403；它不能证明用户当前配置不可用。本报告的真实模型结果来自后续沿用当前配置的运行。

## 静态检查与模拟测试

- 目标构建生成类型的 TypeScript 严格检查通过。
- `claude plugin validate .\spikes\claude-mods-validation --strict` 退出 0。仅提示 marketplace 图标警告，CLI 明确说明不影响验证结果。
- `claude plugin test .\spikes\claude-mods-validation`：1 passed，0 failed。
- 模拟测试检查 `prompt.submit`、`tool.call` 观察器及注册命令；`Bash` 调用被测试 hook 返回的固定结果截获，没有启动真实 Bash。它不证明真实模型推理、权限对话框或远程控制成立。

## 真实官方 TUI 运行结果

首个 TUI 通过以下命令启动，使用当前配置和插件自己的固定提示词：

```powershell
claude --plugin-dir .\spikes\claude-mods-validation --tools ""
```

原生 Session ID 为 `beb71822-473a-4fac-b019-a5e0ea2a0ce0`。以下为本轮运行观察摘要；`reason`、`isAborted`、`turnId` 来自 Mods 事件，而非界面文字推断。

| 场景 | 结果与证据 | 验证边界 |
| --- | --- | --- |
| 插件提交并获得模型回复 | `submit` 使用 `$.prompt.submit({ text, asUser: true })`；回合 `3c1a4eab-b029-42bc-87bd-578477a8809b` 返回 `ORBIS_NATIVE_OK`；`turn.complete` 为 `reason: answer`、`isAborted: false`，固定回复断言通过 | 证明当前 TUI 的真实模型调用；没有 Host/App 链路 |
| 工作中再次提交 | `queue` 在第一个主回合开始 200ms 后提交第二条；先完成 `72d43466-e0b9-45e3-8fa4-188b18564e72`，再开始并完成 `13ba1cfe-3aaa-459d-8f5f-091880a31bba`；分别回复 `ORBIS_NATIVE_OK`、`ORBIS_QUEUE_OK` | 是等待 idle 的提交，不是即时打断或 steer |
| 停止当前主回合 | `abort` 在主回合开始 800ms 后调用 `$.turn.abort`；回合 `00f9b1b8-c3a7-40f4-bfa7-655f5c3e7018` 收到 `reason: aborted`、`isAborted: true`、无答案 | 当时没有运行工具、子任务或待执行队列；这些停止范围未验证 |
| 再停止已结束回合 | `stale-abort` 对上述已结束回合调用被拒绝，记录 `abort.error` | 探针没有保留错误正文，未验证具体错误文案 |
| 电脑输入 | 在 composer 输入固定提示词；观察到 `prompt.submit` 的 `origin: composer`、`wait: false`；回合 `b8f134be-42ee-4f81-a989-3089d14f5431` 回复断言通过 | 本插件自己的 API 提交未触发自身 `prompt.submit` 观察器；不能只依赖该观察器确认提交 |
| 有界消息读取 | 首次回复后 `$.session.messages()` 返回 2 条，最后一条为 assistant；后续 composer 回复后为 9 条 | 未验证持久历史完整性、稳定消息 UUID 或 parent/head 恢复 |
| `/clear` | Session ID 变为 `e545386a-d749-4c52-8825-0d3aa39ec26a`，消息数变为 1；该插件累计 `session.start` 仍为 1 | Session 切换不能仅由 `session.start` 驱动 |
| 退出后恢复 | 先退出自己的 TUI，再用下述 `--resume` 启动；`$.session.id()` 恢复原 ID，消息数为 9，插件收到新的 `session.start` | 是先退出再恢复；未并发运行同一 Session，也未验证旧消息 UUID 恢复 |
| idle 插件重载 | 修改探针后执行官方 `/reload-plugins`，TUI 报告重载 1 个插件；新增状态字段生效，模块计数清空并收到 `session.start`，Session ID 保持原值 | 未验证活动回合、待回答请求及定时任务跨重载恢复 |

恢复测试命令：

```powershell
claude --resume beb71822-473a-4fac-b019-a5e0ea2a0ce0 --plugin-dir .\spikes\claude-mods-validation --tools Read
```

在恢复后的 TUI 中另行测试工具：

- **模型主动调用未通过**：`tool` 要求模型读取本插件 manifest；模型回答无法访问 Read，没有产生相应 `tool.call`，回合正常结束但固定回复断言失败。之后 `$.tool.list()` 的工具清单包含 `Read`。没有证据确定未调用的原因，不能报告当前供应商已通过模型工具调用验收。
- **插件直接调用通过**：`read-probe` 用 `$.tool.call({ tool: 'Read', file_path: ... })` 读取插件自己的 manifest，观察到 `tool.call`，工具 ID 为 `toolu_plugin_128311697bd34e0c9ba1ad33a6cef324`；调用返回且 `text` 非空。没有修改权限规则或绕过审批；该场景没有验证需要人工批准的工具，也没有断言文件具体内容。

测试结束已通过 `/exit` 关闭本任务启动的 TUI。未停止或重启用户 Host，未安装或升级 CLI，未 push 或发版。测试时在官方 TUI 输入命令只用于本地验证，不是接入实现的操作通道。

任务自建的临时配置 `.claude-probe-config/` 和下载缓存 `.claude-probe-npm-cache/` 已清理；验证插件、生成类型及本轮诊断保留在本目录中。

## 目标构建声明核对

下列行号对应上面 SHA-256 的生成文件；该文件已忽略，重新生成后应先核对版本和摘要。以下均为**声明事实**，不扩大上面的运行验收范围。

| 接口 | 类型文件位置 | 对实施的约束 |
| --- | --- | --- |
| `$.prompt.submit` | `PromptSubmitArgs:9430`、`PromptSubmitResult:9574` | 插件不能提供 `origin` / `turnId` / `wait`；提交在 idle 后运行，返回不是回合完成。`asUser` 去掉模型输入的插件说明，但来源仍标为 plugin；文件提及及粘贴图片不会按 composer 方式展开 |
| `$.turn.abort` | `2991` | 按主回合 ID 停止，声明包含运行工具，过期 ID 拒绝；本次只验证无工具的主回合和过期 ID |
| `$.tool.list` / `$.tool.call` | `3091`、`3099` | 前者是当前模型工具清单；后者进入原生工具、hook 和权限检查路径。模型文字不能代替工具清单或调用事件 |
| `$.session.messages()` | `2805`、`SessionMessage:11767` | 最多最近 4096 条；普通返回没有稳定行 UUID、parent/head，`handle` 也明确不在该读取结果中 |
| `session.append` | `SessionAppendInput:11132`、`uuid:11156` | 事件给出稳定 transcript 行 UUID，但不含 parent links、timestamps 等；单靠追加事件不足以恢复旧历史关系 |
| `$.session.authorize()` | `2962`、`SessionAuthorization:11302` | 返回供 `$.http.fetch` 使用的 Anthropic 凭据句柄或 null；不是批准/拒绝现有原生请求的 API |
| `$.ui.ask` | `2452` | 创建新的原生 AskUserQuestion 并等待本地答案，不是回答已存在问题的入口 |
| 原生审批显示与经典 hook | `RenderComponent:9832`、`PermissionRequestHookInput:7707`、`ToolCheckResult:13756` | permission dialog 由 engine 绘制；经典 PermissionRequest hook 可返回 allow/deny，但其输入没有稳定 requestId；对必须由人回答的问题/计划，`tool.check` 的 allow 不会关闭对话框 |

审查 `CoreEngineInterface` 的公开插件调用接口后，**未找到 Mods API 中能回答既有原生待回答请求的 resolver**。这不代表 Claude Code 没有其他公开机制：官方 Channels 文档描述了 MCP channel 的工具审批 relay。

## 官方 Hooks 的审批与问卷回答能力

传统 Claude Code Hooks 与 Mods hooks 是两套接口。Settings/插件可以配置命令 Hook；Claude Code 把事件 JSON 写到 Hook 的 stdin，并读取 stdout 中的结构化 JSON。官方 [Hooks 文档](https://code.claude.com/docs/en/hooks) 描述了下列原生交互路径：

| Hook | 官方契约 | Orbis 可用方式及限制 |
| --- | --- | --- |
| `PermissionRequest` | 在 Claude Code 即将询问工具使用权限时运行。Hook 可通过 `hookSpecificOutput.decision.behavior` 返回 `allow` 或 `deny`；运行中的原生 host 与 Hook 并行处理，先作出决定的一方生效。输入含 `session_id`、`tool_name`、`tool_input`，但没有 `tool_use_id`。 | 每个 Hook 进程可生成随机关联 ID，把工具及参数送到 Host 后同步等待手机明确审批，再把 `allow` / `deny` 写到 stdout。电脑 TUI 的原生审批仍可同时作答，所以需处理本地/远程竞答和重复/迟到答复。默认 command Hook timeout 为 600 秒，可通过配置限制等待时间；不能超时后自动 allow。该事件不覆盖 sandbox 网络提示。 |
| `PreToolUse` 针对 `AskUserQuestion` | 在工具执行前运行，输入有 `tool_use_id`。Hook 收集用户答案后返回 `permissionDecision: "allow"` 和 `updatedInput`，其中包含原 `questions` 与 `answers`（问题文本映射到所选标签或自由文本）；Claude Code 以该输入继续处理同一次工具调用。单独返回 allow 不够。 | Hook 可以将题面和选项发送给 Host/手机，等待回答，然后以 JSON 响应返回；这是对原生工具调用的结构化回答，不需要把文本输入 TUI 或模拟按键。应只对 `tool_name === "AskUserQuestion"` 使用答案流程，并在取消、断线、超时或答复无效时 fail closed 或恢复原生询问。此路线在本机 v2.1.310 TUI 未实测。 |

这解决了“必须注入键盘输入才能答手机问题”的担忧：对于工具审批和 `AskUserQuestion`，Claude Code Hooks 提供了原生结构化请求/响应点。它仍不等于一个通用 composer 输入接口。`$.prompt.submit` 可提交用户消息，但文档定义它等待当前会话 idle 后启动回合；它不能用作当前待审批或待回答问题的答案。Hook 也不自动解决项目目录信任、MCP server consent 等其他流程。

命令 Hook 本身是一次同步进程调用，可以通过 Host 本机通道或有超时的 HTTP 请求等待手机答复；外部 UI、鉴权、请求关联、展示和回执都要由 Orbis 实现。`PermissionRequest` 没有原生 tool-use ID，因此由 Hook 生成并携带调用级随机 ID；`AskUserQuestion` 的 `PreToolUse` 可以使用 `tool_use_id`。在 Orbis 宣称可用前，必须针对目标 Claude Code 版本实际验证两类 Hook 的 stdin/stdout 契约、TUI 显示、并发、本地与远端先答、取消、超时和重连语义。传统 Hook 不要求 `$.session.authorize()` 提供 Anthropic 凭据；当前配置下它为 null 只影响 Channels 等 Anthropic 认证路径。

## 官方文档补充：Channels、Remote Control 与 Agent SDK

| 官方接口 | 文档定义的能力 | 限制及对 Orbis 的含义 |
| --- | --- | --- |
| [Channels](https://code.claude.com/docs/en/channels) / [permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts) | MCP server 以 `notifications/claude/channel` 向正在运行的 TUI 注入消息；双向 channel 可注册 reply tool；声明 `claude/channel/permission` 后可接收 `notifications/claude/channel/permission_request`，含 `request_id`、工具名、说明和参数预览，并用 `notifications/claude/channel/permission` 回传同 ID 的 `allow` / `deny`。本地对话框仍保持打开，由本地或远程先回答者生效。 | 仅覆盖 Bash、Write、Edit 等工具使用审批；不覆盖 project trust、MCP server consent 或 AskUserQuestion。它是独立 MCP channel 协议，不是 Mods resolver，也没有定义完整会话历史、运行状态及 Orbis Host 同步协议。 |
| Channels 部署条件 | 当前标记为 Research Preview。文档要求 claude.ai 登录或 Anthropic Console API key；不支持 Bedrock、Google Cloud Agent Platform、Microsoft Foundry。Team/Enterprise 还需组织启用，并遵守 channel allowlist。开发期自定义 channel 可按官方说明用 development flag 测试。 | v2.1.310 任务 TUI 沿用当前配置实测 `$.session.authorize() !== null` 为 `false`；当前会话不是可供 Channels 使用的 Anthropic 一方认证会话，不能承诺现有自定义供应商可用。 |
| [Remote Control](https://code.claude.com/docs/en/remote-control) | 官方 Claude App/claude.ai 可接续控制本机运行的 Claude Code 会话。 | 要求支持的 claude.ai 订阅登录；API key 不支持，非 `api.anthropic.com` 的 `ANTHROPIC_BASE_URL`、Bedrock、Google Agent Platform、Microsoft Foundry 不支持。它是 Anthropic 官方客户端能力，不提供 Orbis 可直接调用的自定义 Host API。 |
| [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions) / [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions) | Agent SDK 暴露 `listSessions()` 与 `getSessionMessages()`，可枚举 session 并读取本地 transcript 消息及 UUID；也支持用 SDK 自己的执行器管理或恢复 session。 | 这是 SDK 历史读取/执行接口，不是附着到既有官方 TUI 的 Mods 控制 API；不能单凭它证明可控制同一运行实例或恢复实时状态。 |

因此，审批结论应区分三个接口面：**Mods 自身没有已验证的既有请求 resolver；传统 Claude Code Hooks 为工具权限请求及 `AskUserQuestion` 提供结构化的决策/答案响应；Channels 另有基于 MCP 的工具审批 relay**。Hooks 机制符合无需键盘注入的需求，但当前仍是官方契约分析而非本机 TUI 验收；Channels 需要 Anthropic 认证。它们都不自动解决项目授权、MCP consent 及全量双向状态同步。testing kit 的界面操作不属于生产插件 API。没有用自动 allow、另一套插件问题或终端按键来替代这些能力。

公开依据：[Create a mod](https://code.claude.com/docs/en/plugins/mods/create)、[API](https://code.claude.com/docs/en/plugins/mods/api)、[Reference](https://code.claude.com/docs/en/plugins/mods/reference)、[Events](https://code.claude.com/docs/en/plugins/mods/events)。网页会更新，目标构建生成类型仍需逐版本核对。

## 重复验证

从 WorkTree 根目录运行，先确认 `node -p "process.execPath"` 为 Windows 路径、`claude --version` 是预期版本。沿用现有配置，不设置空 `CLAUDE_CONFIG_DIR`。首次用 `--plugin-dir` 加载后，CLI 会生成忽略目录内的类型和本地设置。

```powershell
# TypeScript 安装路径按本机主仓库记录；不要为了检查下载另一套类型。
node D:\orbis\node_modules\typescript\bin\tsc -p spikes/claude-mods-validation/tsconfig.json --pretty false
claude plugin validate .\spikes\claude-mods-validation --strict
claude plugin test .\spikes\claude-mods-validation
```

在自己新建的官方 TUI 中依次运行需要验证的动作，每次等待对应回合结束后读取状态：

| 命令参数 | 动作 |
| --- | --- |
| `/orbis-mod-probe status` | 当前 Session、版本、模型、工具名称、有界消息数量及最近最多 128 条事件摘要 |
| `submit` | 延迟 200ms 提交固定无工具提示词 |
| `queue` | 提交固定提示词，首回合开始 200ms 后再提交第二条 |
| `abort` | 提交固定提示词，主回合开始 800ms 后停止；模型过快完成时需检查实际事件，不能把过期拒绝计为停止成功 |
| `stale-abort` | 再停止上个主回合；刚重载后没有上个回合时使用不存在的 ID，需区分这两种场景 |
| `tool` | 要求模型通过 Read 读取本插件 manifest |
| `read-probe` | 插件通过公开 API 直接调用原生 Read 读取自己的 manifest |

参数用在完整命令后，例如 `/orbis-mod-probe queue`。`status` 写入忽略的 `.claude-plugin/.cache/native.json`；只保存元数据和固定回复是否匹配，不保存提示词、回复正文、供应商 URL 或密钥。reload 会清空探针内存，因此需要在重载前记录当前运行结果。

探针只适用于本地人工验证：延迟回调没有生产实现所需的 Session/连接代次校验；状态计数也不代表完整原生状态。不要把该插件发布为 bridge。只在任务自己的 TUI 使用 `/clear`、`/reload-plugins` 和 `/exit`。

## 尚未完成的验收

- 传统 `PermissionRequest` 与 `PreToolUse` hooks 在 v2.1.310 真实 TUI 中的审批/问卷回答；稳定请求身份、竞答、取消、超时、迟到回答和重连恢复。
- 完整持久历史及 parent/head、旧消息身份恢复、流式中途加入与 live → canonical 去重。
- 有工具、子任务及队列时的停止范围；本地停止后新工作的限制。
- 活动回合/待回答请求期间的 reload、分支、压缩、断线与新 Session 隔离。
- 当前供应商的模型工具调用闭环；本次直接工具调用成功不能代替该项。
- 本机认证通道、Host 的 ADR-0032 归一模型、App 操作、两端回执和多实例隔离。
- 最低版本 v2.1.287 的独立兼容性验收；此次按用户要求未测。

下一步应先确认满足 ADR §4 的公开原生请求回答机制和可恢复历史来源，再确定首版能力与支持版本；当前结果只能支持实验性的消息、回合观察和主回合停止方向。
