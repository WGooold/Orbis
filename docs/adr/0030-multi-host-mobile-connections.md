# ADR-0030：手机端同时连接多台 Host

日期：2026-10-11

关联：[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0028](0028-host-notification-lifecycle.md)。

## 问题与现状

APP 从第一个版本起就把"已配对电脑"当成单数：`CredentialStore` 只存一条凭据、`E2eIdentityStore` 只存一条配对、`RemoteViewModel` 只持有单个 `RelayClient` 与单个 `RemoteState`。配对一台新电脑会覆盖旧记录，会话、下载、历史缓存也都挂在同一个 `hostId` 命名空间上。

这带来三个具体后果：

- 用户无法同时观察两台电脑的会话；切电脑等于重新配对。
- `SessionCatalogStore` 按 `(device, hostId)` 读，但写文件时一个文件只放一台 Host 的目录，第二台会覆盖第一台。
- `sessionId` 只在单台 Host 内唯一，而界面此前假定它全局唯一。

## 决定

### 1. 一台已配对 Host 一个连接

手机保存**配对集合**，每台 Host 一个 `HostConnection`：

| 层 | 负责 |
| --- | --- |
| `HostPairingStore` | 去重后的配对列表（`hostId` 为身份）与"当前 Host"选择 |
| `HostConnection` | 一台 Host 的 Relay socket、E2E 会话、`RemoteState`、reducer、帧循环、下载/上传/历史。与旧 `RemoteViewModel` 的单 Host 逻辑等价 |
| `RemoteViewModel` | 多 Host 中枢：持有全部连接，暴露 `state`（当前 Host）、`hosts`（全部快照）、配对/解配、以及转发到当前 Host 的交互命令 |
| UI | 主页卡片与侧栏展示全部 Host；交互只作用于当前 Host |

`state` 仍然是"当前 Host 最后发布的状态"，因此单 Host 时代的所有界面无需改动语义即可工作。切换 Host 只改交互地址，不重连其他 Host。

### 2. `hostId` 是唯一去重键

`HostPairingStore.add` 按 `hostId` **替换**已有记录并保持原位置：同一台电脑重复配对（新二维码、凭据轮换）只会更新凭据，不会出现两个连接、两棵目录树。旧版单 Host 的 `E2eIdentityStore.paired_host` + `CredentialStore.device` 在首次启动时迁移成一条配对记录，旧数据保留不删。

### 3. `sessionId` 只在 Host 内唯一

合并视图一律以 `(hostId, sessionId)` 作为行身份：

- `cachedHistoryTree(List<RemoteState>)` 产出按 Host 分组的 `CachedHostGroup`，同名 Session 在两台电脑上是两行。
- 会话目录改为每 Host 一个文件；旧 `catalog.cache` 只在该 Host 尚无自有文件时读取一次并迁移。
- 下载与上传任务带上 `hostId`；旧记录在只有一台 Host 时迁移认领，多于一台时保持隐藏，绝不复制进每台 Host 的拉取调度器。
- 上传、草稿、别名、历史缓存、最近打开的会话同样按 `(device, hostId, …)` 或 `hostId` 寻址。

### 4. 配对不打扰在线连接

新增电脑使用独立的 `RelayClient` 完成 `pair-accept`，不复用任何已在线连接，也不做全量 `disconnect()`。旧实现的"配对独占连接"约束因此消失；`pairingAwaitingAccept` 只保留为单连接内的兼容标志。

### 5. 显示：目录前标出所属电脑

主页卡片与侧栏目录前显示所属电脑名称，**所有 agent 一致**（此前只有 Pi 走到 `runtimeDisplayPath()`，Codex 的 `threadMetadata` 漏了 `hostname`，本次补齐）。侧栏在存在多台 Host 时按 Host 分段；抽屉页脚从静态"电脑"标签变成 Host 切换器。

## 影响

- 每台在线 Host 各自维持一条 WebSocket、一套 E2E 与拉取调度器，内存与电量的增量与"多开一个 APP"同阶。
- 下载/上传文件（`download-tasks.json` 等）仍是单文件、共享实例，写入方带 `hostId` 区分；目录缓存按 Host 拆文件。
- 传输路径偏好（lan/p2p/relay 顺序）仍是手机级设置，逐 Host 下发。

## 未决

- 未做跨 Host 的会话去重或合并（同名 Session 视为不同会话）；也未做"全部 Host"的统一未读/通知汇总，通知仍按来源 Host 展示。
