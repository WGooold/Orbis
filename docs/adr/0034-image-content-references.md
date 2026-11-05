# ADR-0034：图片引用的统一模型

日期：2026-10-21

Status: accepted（2026-10-22：Pi 媒体引用及 Codex 工具结果预处理已实现并有测试；可选 path ref 尚未实现。文本线路截断见 [ADR-0038](0038-wire-payload-truncation.md)）

关联：[ADR-0012](0012-receiver-driven-upload.md)（附件路径语义）、[ADR-0005](0005-receiver-driven-range-download.md)（下载）、[ADR-0024](0024-recoverable-session-state-sync.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0035](0035-incremental-session-reconcile.md)

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
| 手机 → Agent | 上传落盘 + 附件路径 | `[附件] <绝对路径>` 文本（ADR-0012 的附件路径语义），不是 content part | — |

补充两条边界：

- 协议侧根本没有图片内容类型：[`RemoteContentSchema`](../../packages/protocol/src/index.ts) 只有 `text | thinking | tool_call | artifact`；[`projectDisplayEntries`](../../packages/protocol/src/display-entries.ts) 的内容映射也只处理 text/thinking/tool_call。**今天没有任何一条路径能把图片送到手机上**，Pi 的 base64 是纯死重量。
- `codex-chat.ts` / `codex-anthropic.ts` 里的 `image_url` / `image` 转换属于 **Host 代理上游 Provider** 的请求改写，不是会话历史投影，不在本 ADR 范围内；那里边的内联 base64 是发往模型服务的，理应有大小上限，但不能与会话同步混为一谈。

结论：图片在 Orbis 里既没有表示，也没有边界。Pi 让它以 base64 长进历史；Codex 让它以 base64 长进工具文本。

## Decision

图片在统一模型中采用确定性引用，由生产者在 canonical 和实时路径统一投影。引用包含 mimeType、byteLength、可选尺寸和可核验的本机路径或 artifact；无法定位时保留明确占位。

Pi 的字符串内联预算初值为 8KB；Codex 工具结果先提取媒体引用，DSH 继续使用文本占位并保留可用路径。手机按文本与 artifact 现有入口展示，图片查看另按下载能力演进。

参考：[`sessionEntryData`](../../packages/pi-extension/src/pi-adapter.ts)。

## Consequences and verification

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。
