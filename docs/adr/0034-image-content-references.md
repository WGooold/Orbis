# ADR-0034：图片以引用进入统一模型，不以 base64 内联

日期：2026-10-21

2026-10-22：文本类超长载荷由 [ADR-0038](0038-wire-payload-truncation.md) 处理。两者是同一原则的两条分支：**线路载荷按展示需要裁剪，存储保留原文**。

Status: accepted（2026-10-22：Pi 侧 §1–§4 已实现并有测试；§5（Codex 工具结果）与 §6 的可选 path ref 尚未实现）

关联：[ADR-0008](0008-drop-backward-compatibility.md)（附件路径语义、artifact 下载）、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0035](0035-incremental-session-reconcile.md)

## Context

手机连上 Host 后 Pi 卡死、内存暴涨。直接成本在同步路径（ADR-0035），但放大器是**图片的 base64 进了 canonical Entry**：Pi 的 `read` 把截图存成 toolResult 的 `{ type: "image", data: <base64>, mimeType }`（实测单张 0.7–1.7MB），pi-extension 原样放进同步状态，于是每次 sync 都在搬运这些字节。

真正缺的不是某个阈值，而是**统一模型里"图片是什么"从来没有定义过**。三个后端各写各的，客户端连图片内容类型都没有。先把事实固定下来。

### 核对过的事实（2026-10-21，对应本仓库当时状态）

| 路径 | 原生表示 | 进入 canonical Entry 的形态 | 手机实际看到什么 |
| --- | --- | --- | --- |
| Pi：`read` 一张图 | 工具结果 `content[]` 含 `{ type: "image", data: <base64>, mimeType }`；Pi 已在 worker 里缩到 ≤2000×2000、base64 ≤4.5MB（`dist/utils/image-resize-core.js` 的 `DEFAULT_OPTIONS`） | **原样保留 base64**：[`sessionEntryData`](../../packages/pi-extension/src/pi-adapter.ts) 只做 JSON 安全化，[`safeValue`](../../packages/pi-extension/src/safe-value.ts) 对字符串**没有长度上限** | 显示投影只取 text/thinking/tool_call，图片块被丢弃；实时消息读成 `[Image omitted: <mime>]`（`pi-adapter.ts:200`）；树预览 `[image]` |
| Pi：用户粘贴的图 | user 消息 `content[]` 含同样的 base64（`agent-session.js` 的 `_normalizePromptImages`） | 同上，原样保留 | 同上 |
| Pi：live 工具事件 | `tool_execution_end.result` 是工具返回值的**原样透传**（`ToolExecutionEndEvent.result: any`） | `tool.finished.result` 带着同一份 base64 上线，并在 `RecoverableSessionSource` 的 live tools 里 `structuredClone` 保留到该 toolResult 落盘 | 手机不渲染工具结果里的图，纯流量 |
| Codex：用户消息带图 | `userMessage.content[]` 的 image item | 只取 text（[`extractContentText`](../../packages/host/src/codex-runtime.ts)），**图片被丢弃且不说明** | 无任何痕迹 |
| Codex：工具结果含图（如截图类 MCP 工具） | 任意 JSON | [`resultText`](../../packages/host/src/codex-runtime.ts) 把整个结果 `JSON.stringify` 成 **text**，base64 会变成正文的一部分 | 一整屏 base64 文本 |
| DSH / DSH web | content block `{ type: "image" }`（文件另走 `{ type: "file" }`） | 归一为占位文本 `[图片：请在 DeepSeek Harness 中查看]` / `[文件：<name>]`（[`dshContent`](../../packages/host/src/dsh-history.ts)），**不带数据** | 占位文本 |
| 手机 → Agent | 上传落盘 + 附件路径 | `[附件] <绝对路径>` 文本（ADR-0008 的 Attachment path 语义），不是 content part | — |

补充两条边界：

- 协议侧根本没有图片内容类型：[`RemoteContentSchema`](../../packages/protocol/src/index.ts) 只有 `text | thinking | tool_call | artifact`；[`projectDisplayEntries`](../../packages/protocol/src/display-entries.ts) 的内容映射也只处理 text/thinking/tool_call。**今天没有任何一条路径能把图片送到手机上**，Pi 的 base64 是纯死重量。
- `codex-chat.ts` / `codex-anthropic.ts` 里的 `image_url` / `image` 转换属于 **Host 代理上游 Provider** 的请求改写，不是会话历史投影，不在本 ADR 范围内；那里边的内联 base64 是发往模型服务的，理应有大小上限，但不能与会话同步混为一谈。

结论：图片在 Orbis 里既没有表示，也没有边界。Pi 让它以 base64 长进历史；Codex 让它以 base64 长进工具文本。

## Decision

1. **canonical Entry 只携带引用，不携带内联二进制。** 图片的统一表示固定为
   `{ type: "image", mimeType, byteLength, width?, height?, ref? }`，
   其中 `ref` 只能是两种之一：
   - 计算机绝对路径（Attachment path 语义：Agent 自己可以 `read` 的那个文件）；
   - artifact 描述符（ADR-0008 的下载路径，`RemoteArtifactSchema`，由生产者经 `custom_message.details.remoteArtifact` 声明）。
   字段里**不允许出现 `data` / `file_data` / `base64` 之类的内联载荷**。
2. **裁剪由生产者负责，且必须确定性。** 各 backend 的 canonical 投影负责把原生图片块降成上面的形状；同一 Entry ID 在任何路径、任何时间都得到同一份投影（ADR-0025 的缓存身份要求），因此占位内容只能来自原生事实（mimeType、字节数、尺寸、路径），不能带时间戳、随机 ID 或运行期计数。
3. **PI 的投影必须自己兜底，不假设上游已裁剪。** [`sessionEntryData`](../../packages/pi-extension/src/pi-adapter.ts) 对任意字符串字段设一条内联预算（初值 8KB）：超过预算的字符串一律降级。图片块转引用；无法给出引用的（例如 base64 来自他人扩展）留 `[image omitted: <mime>, <n> bytes]`。
4. **同规则覆盖事件路径。** `tool_execution_end.result` / `tool_execution_update.partialResult` 走同一裁剪，不能因为"只是一次事件"就整份上线。工具结果里能证明本地路径的（Pi `read` 的 `arguments.path`）可以带 path ref；证明不了就只留占位。
5. **Codex 的 `resultText` 不能无脑 stringify 大二进制。** 工具结果里的图片/文件块先降成引用或占位，再作为 text 内容；不得让 base64 进入 canonical Entry 的正文。
6. **DSH 的占位保持现状**，补上可选的 path ref（DSH 的 `file` 块带 `attachment.name`，能定位就带路径）。手机侧继续按文本/artifact 渲染。
7. **图片可见性不在本 ADR 内交付。** 手机仍显示占位；将来要显示图片另开 ADR，走 artifact 下载（ADR-0008），不复用内联 base64。

## Consequences and verification

- 带截图的会话不再把图片字节带进同步状态，历史体积回到文本量级；`session_entry_too_large` 不再由普通截图触发（ADR-0035）。
- 表示统一后，"后端没把图丢掉"成为可断言的事实：同一份原生历史投影两次必须逐字节相等。
- 代价：手机仍然看不到图片（今天也看不到），且**裁剪规则一变，同一 Entry ID 的 `data` 就变**——按 ADR-0025 那属于 corrected entry，会换 source epoch。规则必须一次定稳，不要在实现里随口加字段。
- 需要执行的验证（实现时补）：
  - Pi：读一张 ≥1MB base64 的截图，`entry.data` 与 `tool.finished` 事件内都搜不到 `data` 字段，且长度受预算约束；
  - Pi：用户粘贴图与 `read` 走同一规则；
  - Codex：工具结果含 image 块时，正文不出现 base64；
  - DSH：占位文本与可选 path ref 不变形；
  - 三个后端的同一原生历史投影两次逐字节相等。
