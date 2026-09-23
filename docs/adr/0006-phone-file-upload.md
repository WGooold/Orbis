# 手机上传文件到电脑（消息附件）

**Status:** accepted

新增一条手机 → 电脑的文件传输，以及让 Pi 能看到该文件的最小方式。**不改动**下载方向的两个既有决定：手机请求型下载（[ADR-0005](./0005-receiver-driven-range-download.md)）与 Pi 主动推送（`artifact.push.*`，已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中删除）。

## Context

手机端 composer 只能发文本，协议层的 `user_message` 也只有 `text`。用户要把手机上的文件交给电脑上的 Pi，没有路。

三个约束决定了实现形态：

1. **Pi 没有任意文件附件这个概念。** `sendUserMessage` 接受 `string | (TextContent | ImageContent)[]`，图片能进 content parts，任意文件不能——只能以路径形式交给 agent，由它自己的工具去读。
2. **Relay 的设备 socket 明确拒收二进制**（`packages/relay/src/index.ts` 对 `isBinary` 直接回 `invalid_message`）。手机发往 Host 的一切都是 JSON 文本，E2E 信封的 `ct` 里是 base64。
3. **Host 是常驻网关**，手机发来的命令由它路由给 loopback 上的 Pi 进程；Host 自己已经就是下载的服务方（ADR-0005 的 §9.4 模型）。

## Decision

**上传与发消息是两步。** 上传先独立完成并落地，消息只携带**已经完成**的附件路径。

- **传输**：手机发 `file.upload.init { requestId, runtimeId, directory, fileName, size, sha256 }`，Host 受理后回 `file.upload.ready { uploadId, chunkSize, receivedBytes }`；手机按信用推 `bin` 分片帧（复用既有的 `PIR3 kind=1` 格式，`transferId` = `uploadId`）；Host 按阈值/节拍回 `file.upload.progress { receivedBytes }` 给信用；手机发完发 `file.upload.done`；Host **自己算 sha256** 校验通过后才改名落地并回 `file.upload.finished { path }`。
- **驱动权在发送方，信用在接收方。** 这是与下载**不同**的地方，也是刻意的：下载时接收方知道自己缺哪一段，所以它能出题（`artifact.read`）；上传时只有手机知道自己有什么字节，Host 无法出题，它只能把持久前缀报回去。所以 `UploadScheduler` 的形状是「已落地 / 已发出」两个游标，而不是范围请求 + 补洞。
- **续传基准是内容身份而不是 `uploadId`**：`sha256(runtimeId, directory, fileName, size, sha256)` 决定 `.part` 的文件名。手机重试、Host 重启都会拿到新的 `uploadId`，但内容身份不变，于是命中同一个 `.part`。持久前缀只增不减。
- **接收方持校验权**（与下载同一原则）：`finished` 只在 Host 自己算完 sha256 之后发。手机报的哈希只用于受理时的续传判据。
- **落地位置**：会话 cwd 下的 `.pi-remote-uploads/`，目录由手机给出、Host 只校验「绝对路径 + 可创建」。Host 不硬编码这段约定，将来加「手机上选目录」时 Host 不需要改。
- **附件就是路径**：`user_message.attachments` 是 `string[]`，bridge 在发送前拼进正文（`附件：<path>`）。**不做**描述符、图片嗅探、content parts——理由见下。
- **能力位**：`RuntimeCapabilities.messageAttachments`。手机只在看到它时才显示上传入口。

## 为什么上传走 base64，而不是给 Relay 加二进制通道

Relay 的设备 socket 拒收二进制，所以手机→Host 的线上体积约为原文件的 **4/3**（分片在 E2E 信封的 `ct` 里是 base64）。100 MB 的文件走 133 MB。

这是**刻意接受**的代价。给 device→runtime 加二进制通道要新增一张路由表、一套背压与丢弃策略，而下载那边已经证明这类改动会把数据面和控制面绑死：`cdc1d80` 之前，中继为了下载背压直接 `close(1013)` 掉整条设备连接，把该设备的**整个控制面**（聊天同步、runtime 事件、交互请求）跟下载一起掐掉——现场表现就是「下载一开，聊天记录一直不刷新」。上传宁可慢 1/3，不再引入那个耦合。

真要提速，正确的做法是给 Relay 加一条与 `transferRoutes` 对称的 `uploadRoutes`，并沿用「只丢分片、绝不断连接」的背压策略。那是另一张票（见 [ADR-0007](0007-channel-multiplexed-delivery.md)）。

## 为什么附件不做成图片/content parts

Pi 确实接受 `ImageContent`，但「这个文件是不是图片、要不要把字节喂给模型」是**模型侧**的事，不是传输侧的事。路径交给 agent，它自己的工具能读、能看图；为图片单开一条分支只会多一份会漂移的实现，还要在扩展里读盘、嗅探、判 MIME。

同理，拼接放在 `RuntimeBridge` 而不是各 runtime 的 port：这是个与运行时无关的纯字符串变换，Pi 与 Codex 走同一个实现，两边行为不会分叉。

## 为什么要能力位（这是本特性最容易被静默违反的地方）

`RuntimeCommandSchema` 是 `z.object`，而 zod 对未知键的默认行为是**静默 strip**：老 bridge 收到带 `attachments` 的 `user_message` 会照常把消息发出去，只是附件没了。用户看到的是「传完了、消息也发了、Pi 完全不知道有这个文件」——没有任何错误。

所以不能依赖「老版本会拒绝」：必须让老版本**看起来就是不支持**。`messageAttachments` 缺省即不支持，手机据此不显示入口。

## Consequences

- 手机端多一个上传任务列表与 `UploadScheduler`；Host 端多一个 `HostUploadService` 与 `.part` 索引。
- 上传期间手机在上传与交互流量之间做「交互让路」（窗口压到 1 分片），与下载同一手法。**这仍然是在绕「所有流量共用一条 E2E 序列」这个根因**——正解见票 07。
- 老 Host 不认识 `file.upload.init`，手机超时后报「电脑端不支持发送文件」；老手机不发 `attachments`，扩展与 Host 都不受影响。
- `.pi-remote-uploads/` 会出现在用户仓库里，需要进 `.gitignore`。
