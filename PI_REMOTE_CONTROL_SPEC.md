# Pi Remote Control 规格（多 agent 远程控制）

## 1. Problem Statement

用户需要一个适合触屏操作的**手机客户端**，用于操作电脑上由 **Host** 托管的 coding agent（目前是 Pi 与 Codex）。电脑上的 Host 是唯一后端与网关：它持有配对身份、设备记录、端到端加密信道、传输路径、文件服务和会话目录聚合；每个 agent backend（Pi / Codex）是自己那份会话内容的实际权威。Android 是一个独立的 Session 客户端，而不是远程桌面、终端模拟器或电脑管理工具。

手机需要能够：

- 查看 Host 上在线的 agent runtime，以及按目录分组的 Pi 与 Codex 统一会话目录；
- 点开一个已经关掉的会话，由 Host 按会话记录里的目录拉起进程并继续（§8 的 L1）；
- 浏览电脑目录，在其中新建会话（§8 的 L2）；
- 查看和切换 Session；
- 查看 Session 当前 branch 的聊天记录；
- 在 agent 生成回复时显示实时流式内容；
- 发送普通消息、steer/follow-up 消息和 runtime 提供的 Slash 命令；
- 停止当前 agent turn；
- 处理 Remote Interaction SDK 提供的结构化交互，以及 agent 的审批请求；
- 按电脑路径下载文件、把手机上的文件上传到电脑；
- 在网络断开或 APP 重启后恢复 Session 元数据和已经缓存的聊天历史。

随着聊天记录增长，APP 如果完全不缓存内容，每次切换 runtime、重连或重新打开 APP 都从电脑端重新加载完整聊天，会造成明显的延迟和不符合 Session 直觉的体验。因此本版本将 APP 从“电脑终端画面的被动镜像”调整为“拥有本地 Session read model 的独立客户端”。

核心变化是：

1. **聊天历史只绑定 Session，不绑定 runtime。** Runtime 只是连接、实时事件和命令路由的对象。
2. **APP 持久化所有已发现的 Session 元数据，但按需加载完整聊天历史。** APP 启动时不读取所有 Session 的完整正文，用户实际打开某个 Session 时才加载其聊天缓存。
3. **APP 缓存结构化 Session tree，而不是只缓存已经压平的 `ChatMessage[]`。** APP 自己根据当前 runtime 的 leaf/branch 计算应该显示的聊天内容。
4. **APP 的显示投影逻辑必须与 Pi 终端逻辑保持一致。** APP 不接收 Pi 已经决定好的最终 UI 内容，而是复现 Pi 的 branch、compaction、消息转换、工具关联和显示规则。
5. **同一个 Session 下的不同 runtime 可以同时位于不同 branch。** APP 共享一份 Session tree，但为每个 runtime 保存独立的当前 leaf 和 branch view，不合并不同 branch 的聊天路径。

---

## 2. Domain Model

### 2.1 Mobile client

原生 Android 客户端。它负责本地 Session catalog、Session tree cache、显示投影、Compose 渲染、输入、重连和用户可见状态。

它不是：

- 终端模拟器；
- 远程桌面；
- Session 文件编辑器；
- Relay 侧的 Session 数据库。

它可以**请求** Host 激活一个会话（§8 的 L1 / L2），但自己不构造命令行、也不直接创建进程：`argv` 与 `env` 一律由 Host 构造。

### 2.2 Pi runtime

一个 Pi 进程——已经在终端里跑着的，或者由 Host 按 §8 拉起的。它拥有：

- Pi `SessionManager`；
- 当前 Session；
- 当前 Session 的 leaf；
- agent、工具、模型、扩展和本地权限；
- Pi 正式的 session/tree/branch/compaction/上下文语义。

它通过本机 loopback 端点接入 Host：对 Host 而言，本机那条通道就是一条「本地 Relay」，说的仍是 runtime 侧既有的那套消息。其它 agent 产品（Codex）由各自的 backend 接入，见 §12 的 `AgentBackend`。每一条 runtime 连接代表一个独立的控制对象。

### 2.3 Runtime ID

连接级身份，是 runtime 命令和实时事件的路由键。**Host 本身也是一个 runtime 连接**，注册时用 `role`（`agent` | `host`）表明身份；Relay 只接受 `role = "host"`，真实 agent 进程只连本机 Host（见 §3.3）。

Runtime ID **不是**聊天缓存身份，也不是 Session ID、entry ID、branch ID 或 leaf ID。

### 2.4 Session

Pi 持久化的 append-only tree。Session 的稳定身份是 `sessionId`，在 Relay 和设备作用域内作为聊天历史的持久化边界。

Session tree 中每个 entry 具有：

- `entryId`；
- `parentId`；
- entry type；
- timestamp；
- 对应的结构化 payload。

Session tree 可以同时包含多个 branch。APP 不把它压平为一条全局聊天流。

### 2.5 Runtime Session View

某个 runtime 对某个 Session 的当前实时视图，至少包括：

- `runtimeId`；
- `sessionId`；
- `leafId`；
- 该 runtime 的实时 streaming overlay。

Runtime Session View 只描述“这个 runtime 当前位于 Session tree 的哪里”，不拥有聊天正文。

### 2.6 Session Entry Graph Cache

Android 本地缓存的结构化 Session tree read model。它按 Session 保存 entry 节点及其关系，不按 runtime 复制聊天正文。

缓存 key 的逻辑作用域为：

```text
relay + device + sessionId
```

不得把 `runtimeId` 放入聊天历史缓存身份中。

### 2.7 Display Projection

APP 根据以下输入自行计算最终聊天显示内容的过程：

```text
Session Entry Graph Cache
+ 当前选中 runtime 的 leafId
+ Pi 版本对应的 branch/compaction/display 规则
+ runtime streaming overlay
→ Android Chat UI Model
```

Display Projection 是 Android 的职责。Pi 提供真实 entry、tree、leaf 和规则参考，但不直接向 APP 下发“最终应该显示哪些气泡”。

### 2.8 Session Catalog

只包含 Session 轻量元数据的持久化索引。至少包括：

- `sessionId`；
- Session name；
- cwd 或项目标识；
- 第一条消息预览；
- 创建时间和最后修改时间；
- Pi 提供的消息/entry 数量信息（如果可用）；
- 是否存在本地聊天缓存；
- 当前在线的 runtime 列表。

Session Catalog 不包含完整聊天正文，因此可以在 APP 启动时整体加载。

---

## 3. Authority Boundary

### 3.1 各 agent backend 的权威范围

每个 agent backend 是它自己那份会话内容的实际权威来源。下以 Pi 为例（Codex 的对应物是它的 thread 语义）：

Pi runtime 是以下内容的实际权威来源：

- Session entry 的创建和持久化；
- `entryId`、`parentId` 和 Session tree 关系；
- 当前 runtime 的 leaf；
- Session branch 的变化；
- compaction 和 branch summary 的生成；
- agent 上下文和工具执行语义；
- runtime 状态、队列和结构化交互；
- 普通消息、Slash 命令和停止操作的实际执行。

Android 不直接读取或修改 Session JSONL，不直接改变 Pi 的 leaf，也不通过本地缓存反向驱动 Pi。

### 3.2 Android 的权威范围

Android 是以下内容的本地拥有者：

- Session Catalog 的持久化；
- Session Entry Graph Cache 的持久化；
- 当前用户选择的 Session 和 runtime；
- 从 Session tree 计算 Android 显示内容的 projection；
- 消息列表滚动位置、折叠状态和 Compose UI 状态；
- 缓存加载、增量合并、缓存替换和离线显示状态。

这里的“Android 拥有”表示 Android 负责本地 read model 和 UI，不表示 Android 可以覆盖 Pi 的真实 Session 状态。

### 3.3 Relay 的范围

Relay 只负责认证、连接管理和消息转发。它读不到 Session 内容：手机与 Host 之间是不透明密文，Relay 能看到的只有信封的**路由头**（帧种类、room、收发方、序号），也不理解 branch 或 display projection。

Host 也以 runtime 身份接入 Relay，那只是为了让 Relay 能把发往 Host 的帧路由到它（`hdr.to = hostId`）。Host 是路由端点（网关），不是手机要看见的进程。因此：

- `runtime.authenticate` 必须声明 `role`，并且**只有 `host` 被接受**：其它角色在认证处就被回绝（`runtime_role_not_allowed`）。中继上那条「运行时直连」入口会把连接事件以**明文**广播给设备，等于让中继看见会话内容——这与「中继零知识」的设计前提直接冲突，所以 Pi 扩展在找不到本机 Host 时也不再连中继（见 [ADR-0008](docs/adr/0008-drop-backward-compatibility.md)）；
- Relay **不再转发运行时的明文事件**：`runtime.event` 一律回绝（`runtime_event_not_allowed`）。会话内容只能经 Host 的端到端通道到达设备；
- 因为 Relay 手里只有网关，它下发的 `device.ready.runtimes` 种子**恒为空**；手机看到的进程目录由 Host 在每次握手完成时自己给（§8.1）。由此，主机上「在跑几个 agent 进程」与 Relay 上有几条 runtime 连接是两件事，手机的进程列表不会因为 Host 接入而多出一条本机目录的假进程。

### 3.4 同一个 Session 的多个 runtime

以下情况是合法的：

```text
Session X
├── shared-root
│   └── shared-entry
│       ├── branch-a → Runtime A 当前 leaf
│       └── branch-b → Runtime B 当前 leaf
```

APP 保存一份 Session X 的 entry graph：

```text
Session X cache = shared-root + shared-entry + branch-a + branch-b
```

同时保存：

```text
Runtime A → leaf = branch-a-leaf
Runtime B → leaf = branch-b-leaf
```

显示 Runtime A 时，APP 只沿 A 的 leaf 回溯 parent 链；显示 Runtime B 时，APP 只沿 B 的 leaf 回溯 parent 链。两个 branch 共享祖先，但不会相互拼接，也不会因为共享 `sessionId` 而产生矛盾。

只有以下情况才属于数据完整性错误：

- 同一个 `entryId` 收到不同的 payload；
- 同一个 `entryId` 收到不同的 `parentId`；
- leaf 指向本地不存在且同步结果没有提供该 entry；
- entry graph 形成非法循环或无法回溯到 root。

发生上述错误时，APP 必须停止合并并请求完整 Session graph 重同步，不能猜测或覆盖已有 entry。

---

## 4. Solution Overview

系统由五个主要部分组成：

1. **Host**：电脑上的常驻进程，持有身份、配对记录、设备表、端到端加密、传输路径、文件服务与会话目录聚合；
2. **Agent backend**：Pi 远程控制扩展（经 loopback 接入 Host）与 Codex app-server 适配器；
3. Android 原生客户端；
4. Relay Server；
5. Remote Interaction SDK。

电脑上的 Host 通过出站长连接接入 Relay，注册身份为 `role = "host"`；Relay 只接受这一个网关角色，因此它手里没有任何 agent 连接，也没有可下发的明文会话内容。手机扫描 Host 打印的配对二维码完成配对（信任根是二维码里的 Host 公钥），之后与 Host 之间流动的是端到端加密的 Envelope：同一条信封可以走 LAN 直连、P2P 直打或被中继兜底，Host 决定当前走哪条并通知手机。

Pi 扩展负责：

- 发布 runtime metadata、Session catalog、当前 Session view 和 Session entries；
- 将 Pi 的实时事件转换为结构化远程协议；
- 将普通消息、steer/follow-up、Slash 命令、停止和交互响应交给 Pi 正式 API；
- 发布当前 runtime 的能力菜单；
- 发布文件下载和结构化交互状态；
- 在 Session、branch、leaf、compaction 或 reload 变化后通知 APP 同步。

Host 负责：

- 身份、配对与设备撤销；
- 把各 agent backend 的会话目录聚合成一棵按目录分组的树下发给手机；
- 按 `sessionId`（L1）或 `{ agentKind, cwd }`（L2）激活会话，并维护在线进程目录（§8）；
- 选择设备当前生效的 Path，并在切换时用 `device.path` 通知手机；
- 按电脑路径服务文件下载、接收手机上传；
- 只做路由与聚合，不解释任何 agent 的业务语义。

Android 负责：

- 持久化所有已发现的 Session 元数据；
- 按需打开对应 Session 的完整本地 history cache；
- 根据 runtime 的当前 leaf 自行计算显示 branch；
- 按 Pi 的显示规则生成移动端 UI model；
- 对实时 entry 和 streaming overlay 做增量更新；
- 通过 `runtimeId` 路由用户命令。

Session、tree、branch、leaf、compaction 和 agent 执行语义仍由各自的 agent backend 拥有（Pi 的归 Pi，Codex 的归 Codex），Host 只做聚合与转发；Android 只复制“读取和显示”所需的投影算法，不复制任何 backend 的写入和执行实现。

---

## 5. Session Catalog and Lazy History Loading

### 5.1 Session Catalog 发布

手机看到的会话目录由 **Host 聚合**后下发：Host 扫各 agent backend 的会话记录，合成一棵按目录分组的树（`session.list`）。运行中的 Pi runtime 连接成功后也会发布它自己发现的 `session.catalog`，经 loopback 由 Host 转发；两份内容同源，手机以 Host 下发的目录为准。Catalog 只包含元数据，不包含完整聊天正文。

Runtime 应在以下情况下刷新 catalog：

- runtime 初次连接；
- Session 新建、resume、fork、clone 或删除；
- Session name 或 Session metadata 变化；
- Pi 发现新的 Session 文件。

如果多个 Runtime 发布同一个 `sessionId`，Android 按 Session ID 合并元数据，但不记录 Runtime 归属或占用关系；为侧边栏分组保留的 `hostname` 和目录只是最近一次写入缓存的展示信息。Runtime 之间的差异只体现在各自的当前 leaf 和在线状态，不产生多份聊天缓存。

### 5.2 APP 启动

APP 启动时必须：

1. 读取设备凭据；
2. 读取轻量 Session Catalog；
3. 恢复 Session 名称、预览、时间和缓存可用性，但不由 Catalog 推导 Runtime 在线状态；
4. 不读取所有 Session 的完整 entry graph；
5. 连接 Relay，先以在线 Runtime 列表作为交互入口，再合并最新 Runtime/catalog 信息。

APP 启动不应因为 Session 数量或历史长度线性读取所有聊天正文。

### 5.3 用户打开 Runtime 或查看缓存历史

用户实际打开某个在线 Runtime 时，APP 才执行：

1. 从该 Runtime 的当前 `sessionId` 定位 Session；
2. 读取该 Session 的本地 Entry Graph Cache；
3. 使用该 Runtime 的当前 leaf 计算并显示 branch；
4. 显示“正在同步聊天记录”状态；
5. 向当前 Runtime 请求该 Session 的增量同步；
6. 合并缺失 entry 或替换无效 cache；
7. 根据新的 leaf 重新执行 Display Projection；
8. 同步完成后将状态改为 live，或在 Runtime 不在线时保持 offline/stale。

在线 Runtime 列表页左侧提供「会话」侧边栏，按「主机 → 目录 → 会话」树状列出电脑上存在的所有 Session——不限于手机缓存过的：会话是聊天记录，进程是运行它的地方，两者互不绑定。主机取 Session 的 `hostname`（扫盘条目没有主机身份，由 Host 在 `session.list.result` 里补本机名），目录取 Session 的 `cwd`。点击一个当前有在线 Runtime 持有的 Session 会切换到该 Runtime；没有被任何 Runtime 持有的 Session（无论手机有没有缓存过）点击后由 Host 拉起进程把该会话加载进去；已有本地缓存的 Session 另有一个只读历史入口，仅显示已有缓存，不发送同步或控制请求。

如果本地没有该 Session 的 history cache，APP 显示加载状态和 Session 元数据，等待完整或增量同步，不把空白误认为 Session 没有聊天记录。

### 5.4 Runtime 窗口、Session 切换和 Runtime 切换

从在线 Runtime A 切换到 Runtime B：

- 保留 A 当前 Session 和 B 当前 Session 的本地 catalog 与 history cache；
- 进入 B 的在线交互窗口，并懒加载 B 当前 Session 的 history cache；
- 使用 B 的 leaf 计算显示内容；
- 不把两个 Runtime 的 branch 消息拼成一条列表。

Runtime 执行 `/resume`、`/new`、`/fork` 或 `/clone` 后，仍保留同一个 Runtime 窗口；APP 保留旧 Session 的 catalog/cache，并根据 Runtime 新上报的 `sessionId` 和 leaf 切换显示。

在同一个 Session X 内从 Runtime A 切换到 Runtime B：

- 不因为 runtime 改变而删除或复制 Session X 的聊天正文；
- 保留 Session X 的 entry graph；
- 切换当前 display cursor 到 Runtime B 的 `leafId`；
- 如果 B 的 leaf 已经在 cache 中，直接重新计算 branch；
- 如果 B 的 branch 有缺失 entry，只请求并追加缺失 entry；
- 不把 A、B 两条 branch 的消息拼成一条列表。

### 5.5 Offline 行为

Runtime 离线时：

- Session Catalog 继续保留；
- 已有 history cache 继续可读；
- UI 明确标记缓存为 stale/offline；
- 不能发送需要该 runtime 的命令；
- runtime 恢复后自动请求同步；
- 不因为 runtime 暂时离线而删除 Session 或聊天缓存。

没有稳定 `sessionId` 的 Pi `--no-session`/ephemeral runtime 不得伪造 Session 缓存身份。此类对话可以保留在内存中供当前 runtime 使用，但 runtime 消失后不保证持久化。

---

## 6. Session History Cache and Versioning

### 6.1 两种版本必须分离

Android 必须分离以下版本：

#### Cache schema version

表示 Android 本地存储结构版本，例如：

```text
cacheSchemaVersion = 2
```

它只用于本地数据迁移，不表示 Pi 聊天历史版本。

#### 同步对账依据

当前同步协议（见 6.4）以 **entry 身份 + parent 链** 对账：

- runtime 是 session graph 的唯一权威写入方（Pi append-only JSONL）；
- entryId 由 Pi 分配、全局唯一且不可变；
- APP 报告自己已知的 `knownLeafId`，runtime 沿 parent 链判断能否增量追加；
- branch 是否改变由 `cursor.leafId` 表达。

本地缓存可以自行维护 `cacheSchemaVersion` / Android `revision` 之类的本地迁移版本号，但它只用于本地数据迁移，不是同步协议的一部分。

#### Branch cursor

当前协议定义（`SessionBranchCursorSchema`）：

```text
leafId
```

branch 是否改变由 `leafId` 表达：runtime 的 leaf 变了，APP 从同一个 Session graph 重新计算 branch。

### 6.2 缓存内容

Session history cache 至少保存：

```text
CachedSession {
  sessionId
  cacheSchemaVersion
  leafId
  entriesById
  sessionMetadata
  updatedAt
}
```

`leafId` 记录缓存当前的同步位置（对应协议 `cursor.leafId`），作为下次 `session.sync` 的 `knownLeafId`。

每个 entry 必须保留足以重建 Pi 显示逻辑的信息，包括：

- entry ID；
- parent ID；
- entry type；
- timestamp；
- message payload；
- custom message 的 customType、display 和 details；
- compaction 的 summary、firstKeptEntryId 等字段；
- branch summary 的 fromId、summary 等字段；
- 工具调用、工具结果和错误所需的关联字段。

只缓存最终 `ChatMessage[]` 不满足本 Spec，因为压平后无法可靠重建 Session tree、branch、compaction 和多个 runtime 的 leaf view。

### 6.3 缓存身份

聊天历史缓存身份必须是：

```text
relay + device + sessionId
```

禁止使用：

```text
relay + device + runtimeId + sessionId
```

`runtimeId` 可以出现在 cache metadata 的“最近来源”字段中，但不能参与决定聊天正文属于哪份缓存。

### 6.4 同步请求和响应

协议应提供 Session graph 同步，而不是只提供线性消息快照。与 `packages/protocol` 当前实现对齐：

```text
session.sync {
  sessionId,
  syncId,
  knownLeafId,      // APP 缓存当前 leaf；无缓存时省略或 null
  targetLeafId,     // 期望的 leaf；省略时为 runtime 当前 leaf（用于切换 branch）
  beforeEntryId     // prepend 边界：只请求该 entry 之前的祖先（懒加载旧历史）
}
```

```text
session.snapshot {
  sessionId,
  syncId,
  cursor: { leafId },
  mode: "append" | "prepend" | "replace",
  entries,
  turnTimings?      // 可选的 turn 时序信息
}
```

字段名可以根据最终协议实现调整，但必须保留这些语义：

- 响应明确属于哪个 Session；
- 响应明确属于哪个同步请求（syncId）；
- 响应携带目标 leaf（`cursor.leafId`）；
- APP 能够按 entryId 幂等追加缺失 entry（append）或向上补祖先（prepend）；
- APP 能够在无法验证关系时完整替换（replace）。

三种 mode 的职责划分：

- **append**：`knownLeafId` 位于目标 leaf 到 root 的路径上，只补路径上缺失的后续 entry；
- **prepend**：`beforeEntryId` 指定边界，只返回该 entry 之前的祖先链——用于长会话首屏只取最近 N 条、向上滚动时按需补旧历史；
- **replace**：无法安全追加时的完整兜底（见 6.6）。

### 6.5 Append 语义

`mode = "append"`（以及 `"prepend"`）不表示把消息数组直接执行 `oldMessages + newMessages`。

它表示：

> 将当前 runtime 观察到、而本地 Session graph 尚未拥有的 entry 节点按 `entryId` 合并进本地 graph，并更新本地 leaf。

新增 entry 可以属于当前 branch，也可以属于当前 Session 中另一个已知 branch。APP 必须按 entry ID 幂等合并，并校验：

- entry ID 未知时新增；
- entry ID 已知且 payload/parent 相同则 no-op；
- entry ID 已知但 payload/parent 不同则拒绝合并并请求 replace；
- parent 缺失时先保留为待解析节点，或请求包含其祖先的同步响应；
- 不得根据 timestamp、消息文本或消息到达顺序猜测 parent。

当前实现说明：runtime 侧的对账逻辑是沿 `targetLeafId` 的 parent 链回溯到 root，检查 `knownLeafId` 是否在该路径上——在则增量追加，不在则作为新分支或触发 replace（实现见 `packages/pi-extension/src/pi-adapter.ts`）。"同 entryId 不同内容"的异常由 Pi append-only JSONL 和 entryId 唯一性排除。

### 6.6 Replace 语义

`mode = "replace"` 只在以下情况使用：

- 本地 cache schema 无法迁移；
- `knownLeafId` 在 runtime graph 中无法定位，且无法通过增量 entry 修复；
- 本地 entry 与 runtime entry 冲突（同 entryId 不同 payload/parent）；
- runtime 无法证明本地 graph 与它的 graph 存在可安全追加关系；
- APP 检测到本地 graph 损坏（parent 链断裂、非法循环）。

Replace 必须以 runtime 提供的结构化完整 Session graph 为基础，不得只替换成当前已显示的线性消息数组。

### 6.7 持久化和清理

Session Catalog 和 Session History Cache 必须独立持久化：

- Catalog 应长期保留所有已发现 Session 的元数据；
- History cache 可以按空间策略清理，但清理正文不能删除 Catalog 记录；
- 清理后重新打开在线 Runtime 或从侧边栏打开缓存历史时，按可用能力重新同步或显示完整 history；
- 缓存写入必须原子化并避免 APP 崩溃留下半份 graph；
- 缓存应加密；
- 取消配对时清除 Catalog、history cache、草稿和相关本地数据。

---

## 7. APP Display Projection Contract

### 7.1 总体规则

APP 自己决定显示哪些聊天记录，但必须对齐 Pi 当前 TUI 的 Session 显示语义。

APP 不把“Pi 发来的当前 ChatMessage 数组”当作最终显示依据，而是执行：

```text
Session graph
→ current leaf path
→ compaction-aware visible/context entries
→ display message projection
→ tool/message association
→ Android UI model
```

Pi 端不负责给 Android 生成最终气泡布局；Android 可以使用与 Pi 不同的移动端视觉样式，但不能改变哪些 entry 被纳入、顺序如何确定、哪些 entry 被隐藏或折叠以及工具结果如何关联。

### 7.2 根据 leaf 构造 branch

APP 必须按 `parentId` 从当前 `leafId` 向 root 回溯，再反转为 root-to-leaf 顺序。

不得：

- 按 timestamp 对所有 Session entry 排序；
- 把 Session 中的所有 sibling branch 平铺显示；
- 把不同 runtime 的消息按到达时间混合；
- 用消息文本推断 branch 关系；
- 把 cache 中其他 branch 的末尾消息追加到当前 branch。

如果当前 runtime 的 leaf 发生变化，APP 重新从同一个 Session graph 计算新的 branch，而不是重新创建一个 runtime 聊天缓存。

### 7.3 Compaction 和 branch summary

APP 必须实现与 Pi `buildContextEntries` 对齐的 compaction-aware 逻辑，包括：

- 沿当前 leaf 找到当前 branch；
- 识别 branch 上最新的 compaction；
- 使用 `firstKeptEntryId` 确定压缩边界；
- 隐藏 Pi 语义上已被压缩、且不再属于当前显示上下文的旧 entry；
- 保留并显示 compaction summary；
- 保留 branch summary 的语义和位置；
- 不因为缓存包含旧 entry 就把它们重新显示到当前 branch。

Pi 的初始显示、compaction 完成后的重建显示和实时流式显示可能有不同的插入时机。APP 应以 Pi 当前 `buildContextEntries`、`sessionEntryToContextMessages` 和 `renderSessionEntries` 的外部行为为基准建立自己的等价 projection，并通过测试固定该行为。

### 7.4 Entry 到显示消息的转换

APP 必须根据 entry type 做确定性转换：

- 普通 user message 显示为用户消息；
- assistant message 显示正文、thinking 和 tool call；
- tool result 按 `toolCallId` 关联到对应工具调用；
- `custom_message` 只有在其 `display` 语义允许时显示；
- `custom`、model change、thinking level change、label 和 session info 等 entry 按 Pi 当前 TUI 的显示规则决定是否显示；
- compaction summary 和 branch summary 作为特殊消息显示；
- 未知且可能改变含义的 entry type 必须 fail closed，不能静默当作普通文本。

Android 可以采用聊天气泡、折叠卡片和移动端 Markdown renderer，但不可以因为 UI 方便而丢弃 entry 的语义。

### 7.5 Tool 和 thinking 展示

- thinking 默认折叠；
- tool call 默认折叠；
- 用户可以展开查看完整内容；
- tool result 必须与正确的 tool call 关联；
- 同一个 Session 中相同文本的消息不能仅凭文本去重；必须按 entry/message ID 去重；
- 同一个 runtime 的 streaming overlay 不能覆盖另一个 runtime 的 tool 状态。

### 7.6 Streaming overlay

实时生成中的消息在 Pi entry 持久化完成前，可以作为 runtime-scoped overlay 保存在内存中：

```text
runtimeId + sessionId + temporaryMessageId
```

overlay 必须带有当前 branch 上下文或 parent anchor。它不能直接追加到 Session 的全局线性消息列表。

收到持久化 entry 后，APP 必须：

1. 按稳定 entry/message ID 与 overlay 关联；
2. 用持久化 entry 替换临时内容；
3. 将 entry 合并到对应 Session graph；
4. 更新该 runtime 的 leaf/view；
5. 重新执行 Display Projection。

如果无法安全关联，保留 overlay 或显示同步提示，不能在另一个 branch 中复制一条消息。

---

## 8. Runtime and Session Lifecycle

`startup`、`resume`、`new`、`fork`、`clone` 和 `reload` 等生命周期事件必须发布新的 runtime Session View，包括：

- 当前 `sessionId`；
- 当前 `leafId`；
- Session metadata。

APP 的处理规则：

- Session 变更时切换 runtime binding，但保留旧 Session 的 Catalog 和 cache；
- 同一个 Session 仅 leaf/branch 变更时，不创建新的聊天缓存；
- runtime reload 不得清除 Session cache；
- 收到旧 runtime/旧 sync 的延迟响应时，必须通过 `runtimeId + sessionId + syncId` 丢弃过期结果；
- 当前选中的 Session 和 runtime 不匹配时，旧响应不能覆盖当前页面；
- Session 删除事件可以删除 Catalog 和 history cache，但必须经过协议确认，不能因 runtime offline 自动删除。

### 8.1 进程是运行会话的地方

**在线 Pi 进程的目录由 Host 维护。** Host 是本机唯一知道「哪些 Pi 进程活着」的一方，它把自己手上的目录下发给手机。手机侧不自行推断进程的存在与否，只显示这份目录。

由此推出三条约束：

- **目录在每次握手完成时补发，而不是只在路径发生变化时补发。** 手机重开 APP 是在同一条路上重新握手——Host 侧的链路对象自始至终没断过，路径选择结果也没变。如果补发只挂在「生效路径变更」上，那么重开一次就永远不会补发目录，手机会停在空目录上（表现为「中继已认手机、但进程全离线」）。因此补发时机是**会话就绪（握手确认）**：每次握手跑完，Host 都在刚刚证明能通的那条路上重发一份 `device.ready`（含完整 runtime 快照）和 `device.path`，路径真变了再附加一次变更通知。
- **会话与进程解耦。** 关闭 APP 不结束任何进程，重开 APP 也只是重新读一遍 Host 的目录；进程的生死不随 APP 或某一次连接变化。Host 重启（哪怕因此换了监听端口）之后，仍然活着的 Pi 会主动重新接回 Host，不会因为一次重启而永久失踪。
- **拉起进程前先发现。** 会话只是被加载进进程的聊天记录：`session.activate` 一个 `resume` 目标时，若该会话已经由一个存活的 Pi 进程持有，Host 复用那个进程，而不是再拉起一个。否则重复点按会在电脑上堆出多个打开同一会话的进程。

**Host 自己不是这条目录里的一项。** Host 会向 Relay 注册（见 §3.3），但它只是网关；它发布的目录只包含真实的 Pi 进程。

### 8.2 电脑做不到的 agent，要在点之前就知道

`session.activate` 的 `new` 目标带 `agentKind`。这台电脑支持哪些 agent **不是手机猜出来的**，而是 `device.ready.agents` 说的；该字段缺省表示未知，此时手机不对选项做限制。

- **只有 Host 说得准。** Relay 在设备认证后也会回一条同名 `device.ready`，但那份 `runtimes` 只是种子目录，且 Relay 根本不知道电脑上装没装某个后端。因此 `agents` 由 Host 在每次握手完成时一并下发。
- **置灰优于报错。** 电脑不具备的 agent，手机直接把选项禁用并说明原因，而不是让人点了再吃一个 `agent_unsupported`——「点了才知道不行」在移动端是一次无谓的往返。
- **失败要如实归因。** Host 用 `protocol.error` 回绝会话请求，码是 `agent_unsupported` / `spawn_failed` / `spawn_limit_reached` / `cwd_missing` / `session_not_found` 等。这些是**电脑端自己的问题**，说成「中继服务器协议错误」会把排查方向引到中继上。

### 8.3 拉起来「有没有窗口」由手机指定，Host 如实回执

`session.activate` 带可选的 `spawnMode`，**缺省即 `tui`**：

- `tui`：**在电脑上开一个可见窗口**（缺省）。手机想要「有头」时发这一档。
- `headless`：不要窗口。
- `auto`：交给 Host 判定。Windows 上只能看 `SESSIONNAME` 这类启发式信号，而从服务、计划任务、SSH 或 IDE 内部启动的 Host 都拿不到它——于是**一律**降级成无头。旧客户端根本不发 `spawnMode`，所以缺省值不能落在这一档上，否则「手机要不到窗口」就是必然。

- **回执就是事实。** `session.activated.spawnMode` 是 Host 真正采用的那一档，手机据此显示（如「此会话无头（电脑上无窗口）」），不自己推断。请求了 `tui` 但本机没有开窗入口（PATH 上没有 `wt.exe`）时，Host 降级为 headless 并在回执里**说 headless**——绝不假装开过窗。
- **开窗命令走 PowerShell 的 `-EncodedCommand`。** Windows Terminal 会把命令行里的引号重新拼接，含空格的路径（cwd、会话文件、会话名）会被拆成多个 token，整条命令甚至会被当成一个可执行文件名（0x80070002，与 §12 里 Codex 开窗是同一个坑）。base64 的 UTF-16LE 是单个 token，`wt` 原样透传。
- **无头进程的 stdin 必须保持打开。** Pi 的 rpc 模式把「stdin 读到 EOF」当作「输入结束」，会干净退出（exit 0）。Host 若按 `stdio: "ignore"` 拉起它，子进程的 stdin 立刻 EOF：进程被记成「拉起成功」，几秒后自己消失——电脑上没有窗口，手机上也**永远等不到这个会话**（`runtime.online` 不会来），而 stderr 同样被丢弃，连一行痕迹都不留。所以 stdin 用保持打开的管道，stderr 收进 Host 日志。

### 8.4 拉起来的「是哪一个」pi / codex，要和终端一致

Host 用 node 直接跑 CLI 的 JS 入口（Windows 上全局安装的 `.cmd` 必须经 shell 才能 spawn，违反 §8.4 的「禁止 shell」）。入口按 **PATH 顺序**解析，只在最后才回退 `%APPDATA%\npm`。

用 nvm-windows 时 `C:\nvm4w\nodejs` 既是 node 安装根也是 npm 全局前缀，通常排在 `%APPDATA%\npm` 前面——终端敲 `codex` 命中的是它。只认 `%APPDATA%\npm` 会让 Host 跑起另一个（往往是更旧的）副本，两台「同名不同版本」的 codex 内置模型表不同，现象就是「APP 里的 codex 能选的模型和终端里不一样」。

---

## 9. Other Runtime Control

聊天历史模型变化不改变以下已有边界。

### 9.1 普通消息和 Slash 命令

普通消息使用 `user_message`，不进行 Android 侧 command/template expansion。Slash 命令只能从当前 runtime 发布的统一菜单中选择，通过 `slash.execute { name, args }` 提交。

这道门对所有后端一致：命令菜单来自 runtime 发布的 `capabilities`（§13.3），后端在自己的适配层把 `slash.execute` 映射到本体的实现（Pi 展开 slash，codex 转 app-server JSON-RPC）。后端没发布的能力就是不出现，APP 不因此分支到「另一种后端」。

Android 不维护命令名称 allowlist，也不把自由输入的 `/...` 发送到模型。

### 9.2 Steer 和 follow-up

Pi 终端真实队列是唯一执行源。电脑端扩展可以维护 shadow queue ledger，用于远程消息关联、幂等和状态同步，但它不是第二个执行队列。

Android：

- 只提交 `user_message { text, delivery, messageId }`；
- 不自行把消息写入 Session history；
- 不根据 WebSocket send 成功伪造 accepted；
- 只根据 Pi 返回的 accepted、delivered、rejected 更新队列展示；
- 当前版本不提供追加消息取消或清空入口。

Queue ID 不能与 Session entry ID 混用。具体 queue 语义仍遵循 Pi 的 steer/follow-up 行为。

### 9.2.1 输入栏状态

输入栏附近显示两个只读状态：当前模型，以及当前上下文占用总上下文窗口的百分比。

- Runtime 在 `runtime.metadata` 中上报 `model { provider, id, name? }` 和 `contextUsage { tokens, contextWindow, percent }`，两者都是可选字段；旧的 Runtime 或 Relay 不发送它们时，Android 保留上一次已知值，而不是清空状态。
- 百分比由 Runtime 给出；Runtime 只给出 token 数时，Android 按 `tokens / contextWindow` 计算。`tokens` 为 null（例如刚完成 compaction）时不显示百分比。
- Android 不根据聊天正文自行推算 token，也不下发任何模型或上下文写入命令；切换模型仍然只能通过 `/model` Slash 命令发起。

### 9.3 Remote Interaction SDK

第三方扩展通过 SDK 声明 confirm、select、multi-select 和 input。业务逻辑保留在电脑端，Android 只渲染声明式请求并提交候选响应。响应必须在电脑端重新校验 runtime、extension、request、kind 和输入约束。multi-select 以 `values` 数组返回，并按 `minSelections`/`maxSelections` 重新校验。

未接入 SDK 的 `ctx.ui` 仍只在电脑端可交互。Android 只能显示“需要在电脑处理”，不能伪造响应。

### 9.4 文件下载

文件下载是 **Host ↔ APP 的直达通道**：手机要下载电脑上的文件，就是「和 Host 交互」。下载仍是一条只读通道：

- 支持手机提交电脑路径和（曾）注册过的 artifact ID；
- Relay 只转发控制消息和二进制分片；
- Android 持久化下载任务和 `.part` 文件；
- 使用接收方驱动的范围请求（下一个请求的 offset 就是进度报告，没有单独的 ACK）、SHA-256 与最终长度校验（见 [ADR-0005](docs/adr/0005-receiver-driven-range-download.md)）；
- 不新增远程编辑、任意 shell 或进程管理（手机 → 电脑的上传是独立的一条，见 §9.5）。

**服务方只有 Host，Pi 扩展不参与下载。** 文件躺在这台机器的磁盘上，而 Host 常驻。寻址方式就是把下载命令的 `runtimeId` 填成 **`hostId`**（Host 在 runtime 空间里的身份）：Relay 据此路由到 Host 连接，Host 就地读盘发送分片。语义上这是一次「请电脑把文件发过来」，与任何 Pi 进程是否存活无关：

- Host 记下每个 runtime 上报的 `artifact.started` 里的 artifact 元数据（含本地路径），据此建立 `artifactId → 路径` 索引并落盘；Host 重启后索引仍在，老会话里的 artifact 照样能下载；
- 手机的 `file.download` / `artifact.download` **只由 Host 服务，不回落给任何 runtime**。Host 服务不了（索引里没有、文件已不在原处、并发已达上限）时，如实回一条失败的 `command.result`（`ok:false, status:"failure"`），而不是把「Host 读不到这个文件」误报成「进程不在线」；
- Pi 扩展**不再暴露下载能力**：`RuntimePort` 没有 `artifact?` / `file?` 钩子，runtime-bridge 收到投向某个 runtime 的下载命令时直接回 `download_served_by_host`（这是寻址错了，不是该进程做不到）；
- 下载任务里记录的那个 `runtimeId` 只是**来源标记**（这个文件来自哪个会话），用于列表分组与回溯，不参与路由；
- `artifact.started` / `artifact.failed` 到达时带的 `runtimeId` 是 `hostId`，因此 APP 按 `transferId`（全局唯一）+ `artifactId` 关联任务，而不是按 `runtimeId`；
- 分片窗口、重试、取消都在 Host 的下载服务里（`packages/host/src/artifact-download.ts`），只有这一份实现。

**APP 侧信息架构**：下载只有一个页面——一个路径输入框、一个下载按钮、一个下载列表。主页面入口和对话窗口上方的下载按钮打开的是**同一个页面**；对话里可点击的文件路径代表「请求 Host 发送这个文件」，同样向 `hostId` 发起。

**主动推送（电脑 → 手机）已删除**（[ADR-0009](docs/adr/0009-remove-computer-to-phone-push.md)）：`runtime.push.*` / `artifact.push.*`、中继的推送队列与持久化、设备的明文进度回执、以及 Android CI 的 APK 投递一起移除。原因：那条链路从未接通（缺 Host 转发那一段），而它要求中继托管用户文件并接收设备明文回执，与「中继只路由」的边界冲突。给手机送文件只有本节的请求型下载一条路——**发起方是手机**。

### 9.5 手机上传文件到电脑

上传是**手机 → Host** 的一条通道，与下载方向镜像对称：落地的是接收方（Host），所以持校验权的也是它。

**上传与发消息是两步。** 上传先独立完成并落地，消息只携带**已经完成**的附件路径。

- 手机发 `file.upload.init { requestId, runtimeId, directory, fileName, size, sha256 }`。`directory` 是手机算好的**绝对**目录（v1 是会话 `cwd` 下的 `.pi-remote-uploads/`），不存在则创建；`runtimeId` 只是「这条上传属于哪个会话」的标注，不参与落地路径。
- Host 受理后回 `file.upload.ready { uploadId, chunkSize, receivedBytes }`。`receivedBytes > 0` 表示命中了同一份 `.part`，手机从那里续传。
- 字节走既有的 `bin` 分片帧（`transferId` = `uploadId`），不新增帧格式。
- Host 按阈值/节拍回 `file.upload.progress { receivedBytes }`——这是**信用**，不是逐片 ACK；`receivedBytes` 单调不减，收到空洞或重复分片时也发一次，当隐式 NACK 用。
- 手机发完发 `file.upload.done`；Host **自己算 sha256**、校验通过后才改名落地，然后回 `file.upload.finished { path, fileName, size, sha256 }`。
- 手机可以 `file.upload.cancel`；Host 用 `file.upload.failed { code, message }` 回报拒绝。

**驱动权在发送方，信用在接收方。** 这与下载正好相反，也是刻意的：下载时接收方知道自己缺哪一段，所以它能出题（`artifact.read`）；上传时只有手机知道自己有什么字节，Host 无法出题，它只能把持久前缀报回去。所以手机侧的 `UploadScheduler` 形状是「已落地 / 已发出」两个游标，而不是范围请求 + 补洞。

**续传基准是内容身份，不是 `uploadId`。** `sha256(runtimeId, directory, fileName, size, sha256)` 决定 `.part` 的文件名，因此手机重试、Host 重启都会拿到新的 `uploadId`，却仍然命中同一份 `.part`。持久前缀只增不减。

**附件就是路径。** `user_message.attachments` 是绝对路径数组（可选），`RuntimeBridge` 在发送前把 `附件：<path>` 拼进正文；agent 拿到的是一条路径，用自己的工具去读。**不做**描述符、图片嗅探、content parts——「这个文件是不是图片、要不要把字节喂给模型」是模型侧的事，不是传输侧的事。附件是**无条件支持**的：能力位已随 [ADR-0008](docs/adr/0008-drop-backward-compatibility.md) 删除。

**落地目录**默认是会话 `cwd` 下的 `.pi-remote-uploads/`，它需要进用户仓库的忽略列表（本仓库已在 `.gitignore` 中忽略）。

**为什么走 base64 而不给中继加二进制通道。** Relay 的设备 socket 明确拒收二进制（`Device messages must be JSON`），所以手机 → Host 的分片在 E2E 信封里是 base64，线上体积约为原文件的 **4/3**（100 MB 走 133 MB）。这是刻意接受的代价：给设备方向加一条二进制通道要新增路由表、背压与丢弃策略，而下载那边已经证明这类改动会把数据面和控制面绑死。真要提速，正确做法是加一条与 `transferRoutes` 对称的 `uploadRoutes`，并沿用「只丢分片、绝不断连接」的背压策略。

---

## 10. Security and Process Boundary

手机能对电脑下达的指令**止于「把 agent 拉起来」**，不包含任意命令。

- **允许**：按已有会话激活（L1，只传 `sessionId`）与在手机选定的目录新建（L2，传 `{ agentKind, cwd }`）；`argv` 与 `env` 一律由 Host 构造（§8）。Host 只认识 `pi` 与 `codex` 两种命令。
- **永久排除**：手机提供命令行或环境变量的任意命令执行（L3），以及任意非 agent 进程管理。
- 手机不能强制终止、重启或自动恢复进程；`/quit` 只能请求当前 agent 通过自身 command context 优雅退出。Host 可以结束它自己拉起的会话进程，但不提供「杀掉任意进程」。
- **已配对设备视为可信**：安全由配对（信任根是二维码里的 Host 公钥）与端到端加密提供，不靠校验设备输入，因此不做 cwd 白名单、不做桌面二次确认、不做速率限制。这三条留在 §8.4 的是职责边界与防手滑，不是安全加固。
- Relay 只读得到路由头，无法读取 Session 内容；它也不再接受 agent runtime 的连接（`role` 必须是 `host`，见 §3.3）。
- 设备凭据可发送消息、调用 runtime 发布的 Slash 命令，并按电脑路径读写 Host 账户可读写的文件——它不是只读凭据。
- 公网使用 `wss://`；可信本地网络可以显式使用受限的 `ws://`；
- 需要整机隔离时使用受限操作系统账户、容器或虚拟机；
- 手机不直接读取 Session JSONL，也不通过任意路径修改 Session 文件；
- APP 的本地 cache 是加密的客户端 read model，不是新的后端权威源。

---

## 11. User Stories

1. 作为 remote 用户，我可以在手机上看到所有在线 Runtime：一个 Runtime 对应一个在线 agent 交互窗口（一个 Pi 进程，或 Codex 的一个活跃 thread），并且能在一棵树里按项目目录同时看到 Pi 与 Codex 的会话。
2. 作为 remote 用户，我可以在 APP 重启后先看到在线 Runtime；并从左侧边栏按“主机 → 目录 → 会话”树状查看电脑上的所有 Session——包括手机还没缓存过的，其中没有被任何 Runtime 持有的 Session 点一下即由 Host 拉起进程把它加载进去。
3. 作为 remote 用户，我可以打开一个 Runtime 时，根据它当前的 Session 和 leaf 先看到本地缓存，再等待后台同步。
4. 作为 remote 用户，我可以打开同一个 Session 的多个 Runtime，而每个 Runtime 保留自己的 branch view，不复制或合并聊天正文。
5. 作为 remote 用户，我可以看到每个 runtime 当前 branch 的独立聊天视图。
6. 作为 remote 用户，我可以在两个 runtime 使用同一个 Session 且分别写入不同 branch 时，不看到两条 branch 被错误合并。
7. 作为 remote 用户，我可以在 Session graph 已经缓存当前 branch 时只切换 leaf 并立即显示对应聊天。
8. 作为 remote 用户，我可以在本地缓存缺少新 entry 时只接收缺失内容，而不是每次重新下载完整历史。
9. 作为 remote 用户，我可以在 branch、compaction、resume、fork、new 或 reload 后看到与 Pi 终端一致的显示内容。
10. 作为 remote 用户，我可以在网络断开后继续阅读已缓存的 Session，并在重连后自动同步。
11. 作为 remote 用户，我可以查看多个在线 Pi runtime，并向选定 runtime 发送消息。
12. 作为 remote 用户，我可以看到 Pi 的流式回复、thinking、工具调用、工具结果和错误。
13. 作为 remote 用户，我可以执行当前 runtime 发布的 Slash 命令并看到结果。
14. 作为 remote 用户，我可以远程处理 Remote Interaction SDK 的 confirm、select、multi-select 和 input。
15. 作为 remote 用户，我可以通过手机停止当前 runtime 的 agent turn。
16. 作为 remote 用户，我可以按电脑路径下载 Host 账户可读取的普通文件或扩展注册的 artifact，也可以把手机上的文件上传到电脑。
17. 作为第三方扩展开发者，我可以使用 Remote Interaction SDK，而不实现 Android 通信和重连逻辑。

---

## 12. Implementation Decisions

- APP 的聊天缓存从 runtime-scoped snapshot 改为 session-scoped Session Entry Graph Cache。
- `runtimeId` 只用于连接、事件、队列、交互、命令和当前 Session View，不参与聊天 cache identity。
- Android 持久化完整 Session Catalog，但不在启动时加载所有 Session entry body。
- Session Catalog 额外保留最近一次写入缓存的 `hostname` 标签，仅用于侧边栏按主机/目录树状分组显示，不代表 Runtime 归属或占用关系。
- Session history 在用户实际打开在线 Runtime 或从侧边栏打开缓存历史时按需加载；缓存可用于快速首屏，但在线 Runtime 永远标记为 cached/stale，直到同步完成。
- Android 自己实现从 entry graph 和 leaf 到显示 UI model 的 projection。
- Projection 必须对齐 Pi 当前 `getBranch`、`buildContextEntries`、`sessionEntryToContextMessages`、`renderSessionEntries` 和实时消息处理的外部行为。
- Pi 扩展向 Android 提供结构化 entry、parentId、leafId 和 Session metadata；不只提供压平后的最终 ChatMessage 数组。
- Session 同步的 append 是 entry graph merge，不是消息数组 concat。
- APP 对 entry ID 做幂等合并，对 entry payload/parent 冲突 fail closed。
- 同一个 Session 的不同 Runtime 可以同时在线；每个 Runtime 保存独立 leaf/branch cursor，APP 不合并 sibling branch。
- Relay 不解析 Session 内容。
- Pi 继续负责 Session 文件写入、branch 创建、leaf 变化、compaction、上下文和 agent 执行；Android 只复制读取/显示投影逻辑。
- 普通消息、队列、Slash、交互和文件下载继续遵守当前 runtime operational control 边界。
- 中继连接在 Host 侧是一条**常驻路径的出口**：中继每次连上都要为每台已知设备重新挂上出口（掉线时出口会随该路径一起摘掉，而链路对象不会重建）。漏掉这一步的表现是「手机发了 HS1，Host 一行日志都没有」——入站帧在找不到出口时只能被丢掉。挂上出口不等于路径可用，可用与否由该路径自己握手成功决定（防手滑）。
- `EnvelopeKind` 是 Host 与中继的共同契约：中继会拒收自己不认识的帧种类，所以新增种类必须**先部署中继**。`node scripts/relay-protocol-probe.mjs` 用于确认线上中继认不认当前协议（防手滑）。
- runtime 注册必须声明 `role`，并且只有 `host` 被接受（`runtime_role_not_allowed`）；中继据此只保留网关：它既不持有 agent 连接，也不广播 agent 的 `runtime.online`/`runtime.offline`（见 §3.3）。
- 手机进程目录的补发挂在 DeviceLink 的**会话就绪**回调上，而不是「生效路径变化」回调上；同一条路上重新握手同样触发补发（见 §8.1）。路径变化通知退化为就绪时的附加信息。
- `device.ready.agents` 由 Host 写入（`["pi"]`，Codex 后端真的接管请求时再加 `"codex"`）。Relay 那条同名的种子 `device.ready` 里该字段是 `null`——中继不知道电脑上装了什么后端；手机把 `null` 解释为未知并放弃限制选项（见 §8.2）。
- Codex 虚拟 runtime 只在**挂着活跃 thread** 时才进进程目录（没会话时它没有 cwd，拿 homedir 占位就是「主页面多出一条用户目录」的假进程）；cwd/状态随激活与 turn 起止变化，变化时重播 `runtime.online`（APP 按 runtimeId upsert）。
- Codex 会话的**有头窗口**是官方 TUI 的 **remote attach**：app-server 以 `--listen ws://127.0.0.1:<port>` 启动（注意这会**取代** stdio，Host 自己的 JSON-RPC 也走这条 WebSocket），开窗命令是 `wt` 里跑 `codex resume <threadId> --remote <endpoint>`。TUI 与手机订阅的是 app-server 内存里**同一个 thread**，消息双同步。实测 `--remote` 并不绕过本地 session 解析：rollout 首轮对话才落盘，所以窗口先开（`-NoExit` 不闪退）、内嵌轮询 rollout，一落盘自动 attach；wt 对带空格的 `-Command` 会重拼引号（实测整条命令被当成可执行文件名，0x80070002），必须走 `-EncodedCommand`。`PI_REMOTE_CODEX_HEAD=0` 可整体关掉。
- Codex 的 `/quit` **只能由 Host 结束本机 TUI 进程**兑现：app-server 没有关闭 TUI 的 RPC（`thread/archive|delete` 是删会话，不是关窗）。Host 按命令行同时命中 `resume <threadId>` 与 `--remote <endpoint>` 结束 codex/node 进程，等待窗口（rollout 未落盘、命令行只有 base64 `-EncodedCommand` 的 powershell）解码后再匹配；随后一律按「TUI 已关闭」下线该 thread，与看门狗发现窗口消失同一条广播路径。这是**有头窗口**的生命周期操作，不扩展到 Pi 进程——§10 的「手机不能强制终止 Pi 进程」不变。
- **agent 后端统一端口（适配器收口）**：目标形态以 Pi 为准——`AgentBackend`（`packages/host/src/agent-backend.ts`）就是 Pi 会话对手机暴露能力的形状：`kind` / `isReady` / `ownsRuntime` / `catalog` / `activate` / `dispatchCommand` / `directoryEntries`。Pi 侧是原生实现（`PiBackend`：目录在磁盘、命令走 loopback），Codex 侧是适配器（`CodexRuntime`：thread ≙ 会话，命令走 app-server JSON-RPC）。会话 id 空间互不相交（§7.5），resume 按 Pi → Codex 顺序问，`session_not_found` = 不归它管；命令路由按 `ownsRuntime` 一次命中——认领了却不认识回 `unsupported_command`，无人认领才回 `runtime_offline`（APP 据此区分「该重拉进程」和「这个后端做不到」）。Host 分派逻辑只面向接口，**不为单个后端写特判**（职责边界）。
- **统一端口的目标契约 = Pi 的接口形式（职责边界）**：`Target` 不是「两套对等规范取并集」，而是**唯一的 Pi 形态**——`RuntimePort`（`packages/runtime-bridge/src/index.ts`）是跑在 Pi 进程内的**事实契约**（Pi 本体被 pi-extension 适配后注册到 loopback 的形状），`AgentBackend` 是同一形状在 Host 侧的收口。任何后端（codex app-server 或未来其他 agent）**必须适配到这套接口语义**，而不是反过来让 Host 或 APP 为某个后端长特判分支。具体含义：
  - **能力是模型声明的，不是客户端硬编码的**：APP 不按 `agentKind` 分支渲染，只看 runtime 发布的 `capabilities`（§9.1）与目录/消息事实。codex 要暴露什么，就在 `capabilities` 里声明什么（§13.3）。
  - **命令走同一条 `dispatchCommand` 车道**：新后端在 `handleCommand` 里按 Pi 已有的命令词表（`user_message` / `slash.execute` / `interaction.respond` / `session.sync` / artifact / file 等）挂上自己的实现；Host 只做 `ownsRuntime` 路由，不感知后端种类。
  - **缺口以「未接线」记账，不以「另一套规范」记账**：Pi 有而 codex 暂时没接的能力，记为「Codex 未对齐项」，必须在适配层补齐到与 Pi 相同的对外行为；补齐之前 APP 靠 `capabilities` 缺席自然降级，而不是靠 agentKind 特判。
- Codex 与 Pi 的**语义对齐范围**：turn 进行中收到无 delivery 的消息 → `command.result` 拒绝（`runtime_busy`，与 Pi 一致）；`followUp` 排队、`steer` 打断当前 turn 后插队（codex 没有向进行中 turn 注入消息的能力，steer ≙ interrupt + 下一个跑我的）；`user_message.cancel` 只撤回排队消息；`turn/start` 失败回 `command.result` 失败 + `isError` 的 `message.finished`。app-server 进程退出 = Codex 掉线，如实广播 `runtime.offline`（防「永远在线」假象）。
- **Codex 未对齐项（必须按上面的目标契约补齐，不是「不做」）**：
  - **Slash 命令**：app-server 侧一一映射到 JSON-RPC（如 `/new`→`thread/start`、`/resume`→`thread/resume`、`/fork`→`thread/fork`、`/compact`→`thread/compact/start`、`/name`→`thread/name/set`、`/model`→`model/list`+config 写入、`/thinking`→`reasoningEffort`、`/tree`→`thread/revert`），并在 `capabilities.commands` 里发布自己实际支持的子集；APP 对 codex 放开 `/` 入口，命令词表来自发布结果而非硬编码。`/tree` 的选项由当前 thread 的条目图投影（复用 Android 同一套历史树页面），动作落到 `thread/revert` 的 `beforeTurnId`——与 codex TUI 里「编辑过去的消息」同一套语义，**原地改写当前会话、不派生新会话**：用户消息用该消息所在轮并把原文交回 APP 回填输入框，助手回复用其所在轮的下一轮。截断后用 `thread/turns/list`（`itemsView: "full"`）重建条目图再广播快照。`thread/fork` 会派生新会话（每跳一次多一条），不符合「编辑过去消息」的预期；`thread/rollback` 对 paginated thread 已不可用。
  - **capabilities 声明**：`CodexRuntime` 必须在 runtime 就绪/激活时发 `runtime.capabilities`（`RuntimeCapabilitiesSchema`），让 APP 无需知道后端种类即可渲染命令与文件下载入口。
  - **file / artifact 下载**：把 app-server 的 `fs/readFile`（及可枚举的产物）接进统一的 `file.download` / `artifact.*` 车道，使 codex 产物可被手机取回；无对应能力时以 `capabilities` 缺席降级，不特判后端。

---

## 13. Testing Decisions

### 13.1 Session graph cache

必须覆盖：

- cache identity 不包含 runtime ID；
- 同一 Session 被两个 runtime 使用时只产生一份聊天正文 cache；
- Session Catalog 和 history cache 独立持久化；
- APP 启动只加载 Catalog，不读取所有 history body；
- 用户打开在线 Runtime 或从侧边栏打开缓存历史后才加载对应 history；
- cache schema migration；
- cache 写入中断和原子替换；
- 取消配对清理 Catalog、history cache 和相关数据。

### 13.2 Graph merge and leaf 对账

必须覆盖：

- known leaf 与 runtime 当前 leaf 相同且路径一致时，不重复请求或重复合并；
- known leaf 位于目标 leaf 到 root 的路径上时，只接收并合并缺失 entry；
- known leaf 不在路径上时，作为新 branch 处理或请求 replace；
- append entry 已存在且完全一致时为 no-op；
- 同一 entry ID payload 或 parent 不一致时拒绝合并并请求 replace；
- 缺失 parent 时请求包含祖先的同步结果；
- graph 损坏、非法循环或无法验证关系时完整 replace；
- replace 后旧 branch entry 不会继续污染当前显示 projection；
- 延迟的旧 sync response 不会覆盖当前选中的 Session/runtime。

### 13.3 Branch projection

必须覆盖：

- APP 按 leaf 和 parentId 构造 root-to-leaf branch；
- sibling branch 不会出现在当前聊天视图；
- 两个 runtime 使用同一个 Session、不同 leaf 时显示各自 branch；
- 两个 runtime 共享祖先时共享 entry，但不重复或混合 branch-specific entry；
- 从 Runtime A 切换到 Runtime B 时，如果 B leaf 已缓存，只重新计算 projection；
- 如果 B leaf 未缓存，只请求缺失 branch entry；
- branch 切换不删除 Session cache 中其他 branch 的 entry。

### 13.4 Pi-equivalent display projection

必须覆盖：

- `getBranch` 的 parent traversal 和顺序；
- 最新 compaction、`firstKeptEntryId` 和旧内容隐藏规则；
- compaction summary 和 branch summary 的显示；
- custom entry/custom message 的 display 规则；
- user、assistant、tool result、thinking 和 tool call 的转换；
- tool call 与 tool result 的 ID 关联；
- 未知 entry type 的 fail-closed 行为；
- APP projection 与固定 Pi 版本 TUI 行为的对照测试；
- Pi 版本升级导致 projection contract 改变时的版本处理。

### 13.5 Streaming and lifecycle

必须覆盖：

- streaming overlay 按 runtime + session + temporary message 隔离；
- overlay 不会写入另一个 runtime 的 branch；
- message finished 后能与持久化 entry ID 正确替换；
- 无法关联时不会复制或错误归属消息；
- startup、resume、new、fork、clone、reload 后 Session View 正确更新；
- runtime session switch 不删除旧 Session cache；
- runtime offline、reconnect 和 APP restart 后按需恢复并重新同步。

### 13.6 Existing runtime control

继续覆盖：

- 消息发送只路由到目标 runtime；
- 同一 Session 的两个 runtime 不会错误广播命令；
- steer/follow-up 的 Pi 队列语义、shadow ledger、幂等和 delivered/rejected 状态；
- Slash 菜单由 runtime 动态发布，Android 不维护独立 allowlist；
- Remote Interaction SDK 的唯一响应、取消、超时和本地/远程竞争；
- 文件下载的路径校验、artifact、接收方驱动的范围请求、SHA-256 和恢复；
- 下载在产生文件的 Pi 进程已经退出时仍然可用（由 Host 就地读盘服务）；Host 服务不了时如实回报失败，不转交给任何 runtime；
- 文件上传的续传命中同一份 `.part`、持久前缀单调不减、Host 自查 sha256 之后才 `finished`、空洞/重复分片被当作隐式 NACK、`directory` 不存在时创建而不是静默换地方；
- 附件路径以 `附件：<path>` 拼进正文交给 agent，且不做图片嗅探或 content parts；
- 会话激活：L1 用会话记录里的 `cwd` 拉起、L2 用手机选定的 `cwd` 新建、`cwd` 已不存在时拒绝且**不换目录**；`browse` 的 `path` 为空时返回盘符、非空时返回子目录与父目录；请求 `tui` 但本机开不出窗口时，回执如实说 `headless`；
- 未认证设备、协议错误和 runtime 不可用时 fail closed。

---

## 14. Android UX Acceptance Matrix

### B1：Session Catalog 启动体验

APP 启动后可以显示所有已持久化 Session 的轻量元数据；不会因为历史很长而一次性加载全部聊天正文。

### B2：按需加载

用户打开在线 Runtime 后立即显示该 Runtime 当前 leaf 对应的已缓存 branch（如果有），并显示正在同步状态；同步完成后更新为该 Runtime leaf 对应的 branch。侧边栏中的只读缓存历史仅显示已有缓存，不发送同步或控制请求。

### B3：同 Session runtime 切换

两个 runtime 绑定同一 Session 但位于不同 branch 时，切换 runtime 只改变当前 leaf projection，不清空 Session cache，也不合并两条 branch。

### B4：增量同步

缓存 graph 与 runtime graph 存在可验证的新增内容时，APP 只接收缺失 entry；不得每次同步都替换完整历史。

### B5：冲突恢复

同一 entry ID 内容冲突、graph 损坏或版本无法验证时，APP 停止猜测并请求完整 Session graph replace。

### B6：Pi 等价显示

APP 显示的当前 branch、compaction、branch summary、thinking、tool call、tool result 和 custom display 语义与对应 Pi 版本一致，视觉布局可以是移动端样式。

### B7：离线阅读

Runtime 暂时离线时，Session metadata 和本地 history 仍可读，页面显示 stale/offline；重连后自动同步，不弹出普通网络掉线错误对话框。

### B8：滚动和实时更新

新 entry、流式增量和工具状态更新不会强制把正在阅读历史的用户拉回底部；用户可以主动回到最新消息。

### B9：草稿隔离

草稿按 relay、device、runtime 和 session 身份隔离；切换 Session/runtime、Activity 重建和 APP 重启后不串稿。

### B10：输入栏状态

在线 Runtime 的聊天页在输入栏附近显示当前模型名和上下文占用百分比；模型切换后（`model_select`）或一轮结束后，两个状态都会随 `runtime.metadata` 刷新。上下文百分比接近窗口上限时有醒目的颜色提示。Runtime 离线或尚未上报时，输入栏不显示空白占位。

### B11：进程与会话的归属

主页面列出 Host 目录里的**每一个**在线进程，不按会话去重：同一个会话被两个进程打开，就是两行。侧边栏列出电脑上的**所有**会话，包括手机还没缓存过的。点侧边栏里没有被任何进程持有的会话，会把该会话加载进一个进程；若该会话已经由一个存活进程持有，则直接复用那个进程，不会在电脑上多起一个。

---

## 15. Out of Scope

- 手机指定命令行来创建进程（§8 的 L3）、强制终止、重启或自动恢复 agent runtime；
- 把 Host 当成通用电脑管理通道：它只起 `pi` / `codex`，不做进程监控、包管理或凭据写入；
- 手机直接读取、编辑或重写 Session JSONL；
- 手机通过缓存直接修改 Session tree、branch 或 leaf；
- Relay 解析或持久化完整 Session 内容；
- 远程 shell、文件编辑、包管理、Provider/OAuth/API key 写入和项目 trust 写入；
- 把同一个 Session 的所有 branch 默认合并成一条聊天流；
- 通过 runtime ID 复制多份 Session 聊天正文；
- 作为 content part 的图片与多媒体消息（附件一律以路径形式交给 agent，见 `docs/adr/0006-phone-file-upload.md`）；
- 未接入 Remote Interaction SDK 的任意本地 TUI 组件自动镜像；
- APP 代替 Pi 执行 agent、tool、queue、compaction 或 Session 写入语义。

APP **不在范围外** 的内容是：为了实现移动端显示，自己维护 Session entry graph read model，并复现 Pi 的 branch、compaction 和 display projection 逻辑。这是本 Spec 的核心范围。

---

## 16. Further Notes

- 产品的持久化核心抽象是 Session；产品的在线交互核心抽象是 Runtime。
- Runtime 是实时控制、在线窗口和 branch cursor 的抽象。
- APP 的本地缓存是 Session graph 的 read model，不是 Pi Session 的第二个写入源。
- “与 Pi 终端逻辑一致”指 APP 自己实现等价的读取/显示投影，而不是让 Pi 把最终 UI 结果直接推给 APP。
- 同一个 Session 下多个 runtime 的合法差异由不同 leaf/parent path 表示；共享 Session ID 本身不会导致聊天冲突。
- 如果 Pi 未来提供正式的 Session graph revision、entry delta 或 display projection API，协议可以直接采用；在此之前，扩展必须发布足以让 Android 安全重建 projection 的结构化数据。
- Relay 仍然不需要理解 Session 语义；所有 Session graph 和 branch 相关数据只在 runtime 与 Android 之间传输。
- Android 视觉设计可以与 Pi TUI 不同，但显示哪些历史、哪些 entry 被省略、branch 如何选择和工具如何关联必须遵循 projection contract。
