# 上传翻转为接收方驱动（与下载同构）

**Status:** accepted（2026-09-18，协议 5→6）

手机上传由 Host 按持久前缀请求字节，上传完成后消息携带附件路径。

## 文件身份与附件边界

- `partKey = sha256(runtimeId, directory, fileName, size, sha256)` 标识可续传内容；每次受理可以生成新 `uploadId`，但重试或 Host 重启仍命中同一 `.part`，续传以实际持久前缀为准。
- 手机通常指定会话 cwd 下的 `.orbis-uploads/`；Host 检查绝对目录及可创建性，保留同名文件并选择可用目标名。Host 排空写链、自行计算 SHA-256 并改名落地后，才返回 `file.upload.finished { path }`。
- `user_message.attachments` 仅携带已完成的绝对路径。RuntimeBridge 将路径并入正文，Agent 用自己的工具读文件；传输层不嗅探图片、不生成模型 content parts，不开放通用文件编辑或进程控制。
- 分片经既有 JSON / E2E 信封传输，base64 增加线路体积。下载由 [ADR-0005](0005-receiver-driven-range-download.md) 规定。

实现与回归：[artifact-upload.ts](../../packages/host/src/artifact-upload.ts)、[artifact-upload.test.ts](../../packages/host/src/artifact-upload.test.ts)、[runtime-bridge](../../packages/runtime-bridge/src/)。

## Context

旧上传是发送方推：手机按信用窗口推 1 MiB 分片，Host 报 `progress`（信用），手机 RTO 超时
回滚重发，最后喊 `done` 由 Host 校验落地。真机（Windows 电脑 + 安卓手机）暴露了
这一形状的结构性问题，2026-09-17～18 连续修了四个补丁仍只见拆东墙：

1. **假发送**：传输写被拒时 `send` 的返回值被丢弃，游标照走，done 照发——Host 零字节，
   RTO 回滚死循环（进度永远 0%）。
2. **done 竞态**：done 之后 RTO 的迟到重发撞上 Host 已删除的传输，`unknown_transfer`
   把一次成功翻转成失败（「先显示完成、再显示不在电脑端」）。
3. **读流错位**：RTO 重传走重开路径时读的是刚被关闭的旧流（`Stream Closed` 隔拍交替）。
4. **心跳饿死**：大文件把手机上行灌满，websocket 的 pong 排在分片后面迟到，被中继 30s
   心跳判死 → 断连（大文件走中继必现）。

共同根源：**发送方在推断接收方的状态**（RTO 猜丢、信用窗口猜容量、done 猜收齐）。
而下载（ADR-0005）早已证明接收方驱动没有这一类问题——接收方看到的洞就是事实本身。

## Decision

上传由 Host 按持久前缀请求数据，并在写入和摘要校验完成后发布结果；续传复用既有文件身份。

- 手机以 `file.upload.init` 声明文件，Host 发送 `file.upload.read { uploadId, offset, length }`。
- 手机使用既有二进制帧响应，`transferId = uploadId`。
- Host 在 `durableBytes == size` 后排空写链、校验 SHA-256、落地并发布 `finished`。
- 恢复复用幂等 init 与已有 `.part`；进度事件用于界面呈现。

2026-10-23 调度参数：拉取检查间隔由 200ms 调整为 25ms，每条上传保留一个在途请求，超时按同偏移重读。写链完成后继续拉取。在 1 MiB 请求粒度下，间隔对应的理论上限由 5 MiB/s 调整为 40 MiB/s；实际吞吐以测量为准。

## Consequences

- 初次引入时协议由 5 升至 6；当前兼容与能力演进按 [ADR-0064](0064-protocol-compatibility.md)。
- 传输节奏由 Host 掌握：agent 忙时 Host 自己少拉即可，手机侧不再需要 interactive 压窗。
- 手机侧「退出窗口」不再影响上传：任务与 chip 关联记在 ViewModel 按会话恢复；
  进程被杀后由持久层标 paused，重新 advertise 原地续传。
