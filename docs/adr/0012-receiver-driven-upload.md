# 上传翻转为接收方驱动（与下载同构）

**Status:** accepted（2026-09-18，协议 5→6）

手机上传由 Host 按持久前缀请求字节，上传完成后消息才携带附件路径；不再使用手机按信用推分片和 `done` 收尾。

## 文件身份与附件边界

- `partKey = sha256(runtimeId, directory, fileName, size, sha256)` 标识可续传内容；每次受理可以生成新 `uploadId`，但重试或 Host 重启仍命中同一 `.part`，续传以实际持久前缀为准。
- 手机通常指定会话 cwd 下的 `.orbis-uploads/`；Host 检查绝对目录及可创建性，保留同名文件并选择可用目标名。Host 排空写链、自行计算 SHA-256 并改名落地后，才返回 `file.upload.finished { path }`。
- `user_message.attachments` 仅携带已完成的绝对路径。RuntimeBridge 将路径并入正文，Agent 用自己的工具读文件；传输层不嗅探图片、不生成模型 content parts，不开放通用文件编辑或进程控制。
- 分片经既有 JSON / E2E 信封传输，base64 增加线路体积；不恢复 Relay 托管文件或独立明文上传路由。下载由 [ADR-0005](0005-receiver-driven-range-download.md) 规定。

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

上传与下载同构，翻转为**接收方驱动**：

- 手机 `file.upload.init`（advertise：目录/文件名/大小/sha256，partKey 续传语义不变）；
- Host 按自己的持久前缀发 `file.upload.read { uploadId, offset, length }`（25ms 拉取节拍、
  1 块在途、1s 超时重拉）；
- 手机应答 `bin` 数据帧（既有帧格式，`transferId` = `uploadId`）；
- `durableBytes == size` 时 Host 自己收尾：排空写链 → sha256 → 落地 → `finished`。
  **`file.upload.done` 与信用语义的 `progress` 删除**（progress 降级为纯 UI 事件）。

推模式的全套补丁随之删除：`UploadScheduler`（RTO/窗口/假发送防护）、done 宽限期、
完成终态翻转防护、`unknown_transfer` 自动重发起（由「10s 无 read 自动重新 advertise」取代——
init 幂等，Host 命中同一份 `.part` 原地续传）。

附带收益：在途量由 Host 的拉取节奏天然限为 1 块，手机上行不再被灌满，中继心跳不再被饿死
（问题 4 随 push 一起消失）。

2026-10-23：用户要求提高限制吞吐的保守参数。Host 拉取检查频率从 5 次/秒提高到 40 次/秒（200ms → 25ms）；1 MiB 请求粒度下，由检查间隔产生的理论请求速率上限从 5 MiB/s 提到 40 MiB/s。仍保持每条上传最多一个在途请求、1 秒同偏移重试和按持久前缀发请求。收到块后设置 `writing`，写链完成前不再拉取，避免缩短检查间隔后在持久偏移尚未推进时重复拉同一块。该值是调度上限，不是实测上传速度。

## Consequences

- 初次引入时协议由 5 升至 6；当前兼容与能力演进按 [ADR-0064](0064-protocol-compatibility.md)，不恢复旧 push 数据面。
- 传输节奏由 Host 掌握：agent 忙时 Host 自己少拉即可，手机侧不再需要 interactive 压窗。
- 手机侧「退出窗口」不再影响上传：任务与 chip 关联记在 ViewModel 按会话恢复；
  进程被杀后由持久层标 paused，重新 advertise 原地续传。
