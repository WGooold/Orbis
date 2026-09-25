# Pi vs Codex 功能对比（历史快照）

> 状态：2026-09-23 的能力盘点。本文用于保留当时的对齐依据，不是当前路线图或实时能力清单；当前行为以源码、根目录 README、相关 ADR 和 `docs/codex-permissions.md` 为准。

> 口径：**不按协议方法清单对齐，只按"用户在手机上能不能对电脑上的 agent 干这件事"对齐**。
> 上一版（按协议清单）把 Pi 的 slash 命令和 codex 的 RPC 方法各自算成对方的"缺口"——按功能看它们是同一批功能的两种入口形式：Pi = 用户敲命令文本 → host 转发本体执行；codex = 客户端直接调 JSON-RPC 方法。本版按功能重新判定。
> 来源：`packages/protocol`（RuntimeCommand/RuntimeEvent）、`packages/pi-extension`、codex-cli 0.154 app-server v2 schema（`docs/codex-app-server-protocol.md`）。

## 一、核心域：远程会话控制 —— 功能一一对应，全部等价

| 功能 | Pi 实现 | codex 实现 | 判定 |
|---|---|---|---|
| 新建会话 | `/new`（slash → host → Pi） | `thread/start` | ✅ 等价，形式不同 |
| 恢复历史会话 | `/resume` + `session.activate` | `thread/resume` | ✅ 等价 |
| 会话列表 / 目录 | host 扫盘 catalog | `thread/list` + 磁盘 rollout | ✅ 等价 |
| fork 分支 | `/fork` | `thread/fork` | ✅ 等价 |
| 会话改名 | `/name` | `thread/name/set` | ✅ 等价 |
| 压缩上下文 | `/compact` | `thread/compact/start` | ✅ 等价 |
| 会话树 / 回退 | `/tree`（切分支） | `thread/rollback` | ✅ 近似等价 |
| 模型选择 | `/model` | `model/list` + `config/value/write` | ✅ 等价（host 未接线） |
| 思考力度 | `/thinking` | `reasoningEffort`（config 写入） | ✅ 等价（host 未接线） |
| 发消息 | `user_message` | `turn/start` | ✅ 等价 |
| 打断 | `stop` | `turn/interrupt` | ✅ 等价 |
| 插队（打断+注入） | delivery=steer | `turn/steer` | ✅ 等价 |
| 忙时排队发送 | delivery=followUp + `message.queued` | 无原生，host `#enqueueWhileBusy` 排队模拟 | ✅ host 已补齐 |
| 撤回排队消息 | `user_message.cancel` | 无原生，host 队列里删 | ✅ host 已补齐 |
| 历史条目图同步 | `session.sync`/`session.snapshot` | 无原生，host 读 rollout 重建 + syncId 回显 | ✅ host 已补齐 |
| 流式回复 | `message.started/delta/finished` | `item/agentMessage/delta` + `item/completed` | ✅ host 映射 |
| 思考流 | `message.delta` contentType=thinking | `item/reasoning/*` | ✅ host 映射 |
| 工具调用展示 | `tool.started/updated/finished` | `item/completed`（commandExecution/fileChange/mcpToolCall） | ✅ host 映射 |
| 运行状态 | `runtime.status` | `thread/status/changed` | ✅ host 映射 |
| 上下线 | `runtime.online/offline` | 无通知，host 按 thread 生命周期造 | ✅ host 造 |
| 命令/文件改动审批 | `interaction.requested`/`respond` | `item/*/requestApproval`（服务端请求回帧） | ✅ host 映射 |
| 运行错误 | `runtime.error` | `error` 通知 | ✅ 透传 |

**上一版两项"大缺口"的重新判定：**

- **slash 命令 vs thread/\* 方法**：不是两个功能，是同一批功能的两种入口。codex 不需要 slash（客户端直接调方法），Pi 需要 slash（本体只吃命令文本）。真实工作量只有：APP 端对 codex 放开 `/` 入口 + host 把 slash 翻译成方法调用。
- **capabilities 发布**：Pi 是动态协商（告诉 APP 有哪些命令/模型/上下文水位）；codex 是静态 schema（客户端已知一切）。功能等价物 = `model/list` + `thread/tokenUsage/updated`，数据都在，只是 CodexRuntime 没发布 → APP 状态栏没内容。是形式差异 + 接线缺口，不是能力缺失。

## 二、文件传输 —— 功能等价，Pi 多一个"主动推送"

| 功能 | Pi | codex | 判定 |
|---|---|---|---|
| 把电脑文件拉到手机 | `file.download`（路径 + 分片） | `fs/readFile`（路径整读） | ✅ 功能等价；host 未把 fs/readFile 接成 file.download |
| 产物主动推送（agent 生成即出现在手机） | ~~`artifact.push.*`~~ | 无对应 | ❌ 已删除（ADR-0009）：两端都只能客户端拉 |
| 大文件分片 / 断点续传 / sha256 | artifact 传输协议全有 | `fs/readFile` 无分片 | ⚠️ Pi 增强，大文件场景可用分片读绕过 |
| 电脑文件浏览 / 管理 | 无 | `fs/readDirectory/writeFile/copy/remove/watch` | 协议 codex 有、host 未接 → 手机端两边都没有 |

## 三、真实不对称（无法互相解释的部分）

### codex 多、Pi 本体真没有 —— 产品层差距，协议层补不出来

| 域 | codex 方法 | 说明 |
|---|---|---|
| MCP 服务器生态 | `mcpServer/*`（安装/oauth/调用/状态） | Pi 本体无 MCP 支持 |
| 插件市场 | `plugin/*`、`marketplace/*` | Pi 无插件生态 |
| 账号体系 | `account/*`（登录/用量/限额） | Pi 用本地 API key，无账号概念 |
| 远程交互终端 | `command/exec` + write/resize/terminate | 手机上直接开电脑 shell；Pi 协议无 |
| 实时语音 | `thread/realtime/*` | Pi 无 |
| 本地工具链杂项 | hooks、fuzzyFileSearch（TUI 补全用）、windowsSandbox、externalAgentConfig 导入、attestation、feedback | 与远程控制无关或低相关 |

### Pi 多、codex 真没有

- **artifact 主动推送**（agent 生成产物即时到手机，含分片/续传/sha256）—— 唯一无对等协议的 Pi 增强
- 终端状态指示器、turn 计时持久化、loopback 注册 —— host 侧实现细节，非用户可见功能

### 双方本体都有、远程协议都没暴露 —— 对手机端等于"两边都没有"

- **skills 管理**：Pi 本体有 skills（skillPaths / skill 命令展开），codex 有 `skills/list`+`config/write` —— 双方都只在电脑本地用，手机端都没有管理入口
- **会话删除 / 归档**：codex 有 `thread/delete/archive`；Pi 本体删文件即删会话但协议未暴露 —— 手机端两边都不能删

## 四、结论

1. **核心判断成立**：远程控制一个 coding agent 的核心功能域（会话 / 对话 / 模型 / 审批 / 状态），两边一一对应，差别只是形式（Pi = slash + 动态 capabilities；codex = RPC 方法 + 静态 schema），且 host 补丁已把无原生支持的项（排队、撤回、历史同步、审批映射）全部拉平。
2. 剩余真实差距收敛为三类：① Pi 独有的 artifact 推送；② codex 独有的产品生态（MCP/账号/插件/终端/语音——Pi 本体没有，协议层补不出来）；③ "双方都有但都没接线"的 skills 管理 / 会话删除（想做都能做）。
3. 因此"把 codex 补齐到 Pi 水平"的真实工作量比上一版文档看起来小得多，只有 3 件：
   - **slash + capabilities**：APP 端 codex 放开 `/` 入口，host 加 capabilities() 发布 + slash→方法映射（`/model`→model/list+config、`/compact`→thread/compact/start、`/new`→thread/start、`/name`→thread/name/set、`/fork`→thread/fork、`/thinking`→reasoningEffort）
   - **file.download**：host 把 `fs/readFile` 接成 file.download 协议
   - **artifact 推送**：无对等协议，用"生成物路径 + file.download"兜成二等体验
