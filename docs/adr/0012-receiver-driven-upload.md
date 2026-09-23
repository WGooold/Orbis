# 上传翻转为接收方驱动（与下载同构）

**Status:** accepted（2026-09-18，协议 5→6）

取代 [0006](./0006-phone-file-upload.md) 中「手机按信用推分片 + done 收尾」的**手机上传**数据面。
0006 的身份设计（partKey 内容身份、`.part` 续传、sha256 收尾校验、sha256 落盘目录）**不变**。

## Context

0006 的上传是发送方推：手机按信用窗口推 1 MiB 分片，Host 报 `progress`（信用），手机 RTO 超时
回滚重发，最后喊 `done` 由 Host 校验落地。真机（Windows 电脑 + 安卓手机，中继/P2P 双路径）暴露了
这一形状的结构性问题，2026-09-17～18 连续修了四个补丁仍只见拆东墙：

1. **假发送**：P2P 写被拒时 `send` 的返回值被丢弃，游标照走，done 照发——Host 零字节，
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
- Host 按自己的持久前缀发 `file.upload.read { uploadId, offset, length }`（200ms 拉取节拍、
  1 块在途、1s 超时重拉）；
- 手机应答 `bin` 数据帧（既有帧格式，`transferId` = `uploadId`）；
- `durableBytes == size` 时 Host 自己收尾：排空写链 → sha256 → 落地 → `finished`。
  **`file.upload.done` 与信用语义的 `progress` 删除**（progress 降级为纯 UI 事件）。

推模式的全套补丁随之删除：`UploadScheduler`（RTO/窗口/假发送防护）、done 宽限期、
完成终态翻转防护、`unknown_transfer` 自动重发起（由「10s 无 read 自动重新 advertise」取代——
init 幂等，Host 命中同一份 `.part` 原地续传）。

附带收益：在途量由 Host 的拉取节奏天然限为 1 块，手机上行不再被灌满，中继心跳不再被饿死
（问题 4 随 push 一起消失）。

## Consequences

- 协议 5→6（ADR-0008 硬门槛）：Host 与 APP 必须同步升级，不做协商。
- 传输节奏由 Host 掌握：agent 忙时 Host 自己少拉即可，手机侧不再需要 interactive 压窗。
- 手机侧「退出窗口」不再影响上传：任务与 chip 关联记在 ViewModel 按会话恢复；
  进程被杀后由持久层标 paused，重新 advertise 原地续传。
