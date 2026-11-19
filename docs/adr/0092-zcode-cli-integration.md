# ADR-0092：ZCode 独立 CLI 接入

日期：2026-11-19

Status: accepted（接入边界已定；实现与真实 CLI 验收按 ZCODE-02–05 分 ticket 完成）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0076](0076-deepseek-harness-desktop-integration.md)、[ADR-0079](0079-codex-vscode-integration.md)。

## 问题与结论

Orbis 需要通过 Host 远程查看并操作 ZCode 会话。ZCode CLI 提供 stdio app-server；当前聊天主路径是 ZCode Protocol V4。ZCode Desktop 内部启动的 app-server 没有在本次调查版本中找到可供 Orbis 稳定连接的公开端点。直接再启动一个 app-server 并共用默认会话数据库，会产生两个独立进程同时拥有同一原生 session 的风险；上游 `session_runtime_presence` 用于阻止删除仍被运行时持有的 session，不是单写者锁。[F01–F05]

采用**独立 CLI 接入**：Host 为 Orbis 启动 `zcode app-server --stdio`，以 V4 作为唯一聊天协议；新增 `agentKind: "zcode"`，不代表连接 ZCode Desktop。该进程使用 Host 数据目录下单独的 ZCode session database，并通过 `ZCODE_SESSION_DB_PATH` 配置。ZCode 用户级和项目级配置仍由 CLI 按原规则读取；Orbis 与 ZCode Desktop 的会话历史不导入、不复制、不合并，也不互相操作。ZCode Desktop 接入须等待上游提供稳定外部端点或可验证的会话写入互斥机制，另立 ADR。

Host 将 V4 事实映射到 Orbis Agent state；手机只消费 Orbis 协议，不直接解析 ZCode 帧。新 kind 仅发送给声明 `agent.zcode` 的设备，未声明的旧 App 不得收到 ZCode catalog、runtime、state 或 backend 条目。[F06]

## 调查版本与证据

调查固定到上游 `zai-org/ZCode` tag `v3.18.2` / commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`（2026-11-16 发布），其中 `zcode-cli` package 版本为 `0.17.1`。本 ADR 的版本结论不自动覆盖后续发行版；升级支持范围前需重新核对协议、会话存储和进程归属。

| ID | 已确认事实 | 上游依据 |
| --- | --- | --- |
| F01 | CLI 提供 `app-server --stdio`；该入口以 stdio NDJSON 与宿主通信。 | [CLI dispatch](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/cli/src/run.ts)、[protocol entrypoint](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts) |
| F02 | 新聊天功能的主路径为 V4 conversation topic、snapshot/delta 与 `v4/command`；旧 `session/*` schema 保留兼容用途，不是新聊天入口。V4 wire protocol version 为 3。 | [ZCode Protocol](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/zcode-protocol.md)、[V4 core schema](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol-v4/core.ts) |
| F03 | V4 command 信封含 session、workspace 与稳定 command identity；写入由 command inbox 裁决，读取通过 conversation topic 订阅并接收 snapshot/delta。 | [V4 command schema](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/shared/src/zcode-protocol-v4/command.ts)、[协议说明](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/docs/zcode-protocol.md) |
| F04 | 默认 session DB 是 `~/.zcode/cli/db/db.sqlite`；环境配置适配器接受 `ZCODE_SESSION_DB_PATH`，并将其写入 `storage.sessionDbPath`。 | [default config](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/contracts/src/config/index.ts)、[environment config](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts)、[session store bootstrap](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/bootstrap/src/app/session-store.ts) |
| F05 | `session_runtime_presence` 按 session 和进程 owner 记录 runtime；已核对的用途是在删除检查时拒绝删除仍有其他活进程持有的 session，没有证据表明它会阻止第二个 app-server 驱动同一 session。 | [SQLite session store](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts)、[deletion inspection](https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/sessions.ts) |
| F06 | Orbis 有设备级 `device.features` 能力协商；ADR-0076 已用 `agent.dshDesktop` 隔离未知 kind，避免旧客户端严格 schema 拒绝整个目录或状态消息。新 kind 沿用该机制。 | [ADR-0076 DSH-DESKTOP-06](0076-deepseek-harness-desktop-integration.md)、[Host device projection](../../packages/host/src/dsh-desktop-visibility.ts)、[protocol features](../../packages/protocol/src/index.ts) |

本次调查未发现 ZCode Desktop 对外公布的 app-server endpoint 或 endpoint 描述文件。该项是“在固定调查范围内未找到”的结论，不代表上游将来不会提供此接口。

## 决策

### 1. 独立 backend 身份

新增 `agentKind: "zcode"`，runtime/session ID 使用独立且可判定归属的前缀。`zcode` 表示 Orbis Host 管理的 ZCode CLI app-server，不表示 Desktop 实例。当前不新增 `zcodeDesktop`，也不以共享数据库、相同 session ID 或相同 workspace path 推断 Desktop 在线归属。

### 2. V4 是唯一聊天协议

Host 通过 stdio 运行受支持版本的 ZCode CLI，并实现 V4 transport、workspace/conversation 订阅和命令收发。新的聊天目录、状态、发送、停止及交互操作不得调用旧 `session/*` 兼容接口。未支持或无法与 Orbis 语义一一对应的原生能力，不在 Host/API/UI 中宣称可用；V4 schema、协议版本或必要字段不匹配时，后端不可用并给出可诊断错误，不静默降级到旧协议。

### 3. Orbis session DB 与 Desktop 隔离

Host 为 ZCode backend 分配持久、Host-scoped 的 session DB 路径，并在子进程环境设置 `ZCODE_SESSION_DB_PATH`。不得修改 ZCode 用户配置文件来改变此路径。Host 只在自己的该 DB 内建目录、恢复和操作 session；不得直接读写默认 Desktop DB，不得复制/迁移其会话，不得尝试以同 session ID 同时驱动两个 app-server。用户可在 ZCode Desktop 与 Orbis 分别创建会话，但两边的 session 目录及历史不互通。

若当前 ZCode CLI 不支持该环境变量、启动后的有效 DB 路径与 Host 预期不一致，或存储隔离无法验证，则拒绝启动 backend；不得回退到默认共享 DB。

### 4. Agent state 与客户端兼容

Host 将支持的 V4 snapshot/delta、历史、执行阶段、交互、配置和工具事实映射到既有 Orbis Agent state。原生字段仅在有明确语义映射时映射；缺失信息按 Orbis unavailable/unknown 表达，不伪造状态。新增设备能力值为 `agent.zcode`。只有设备在本次握手声明该 feature 后，Host 才能向其发送 ZCode kind 的 catalog、runtime、Agent state、provider 或 operation 数据；旧设备视图需在计算增量前过滤，游标与分页总数基于过滤后的视图。

### 5. 版本支持与验证门槛

首个适配基线为 `zcode-cli 0.17.1`（ZCode `v3.18.2`，V4 wire version 3）。至少验证：NDJSON 帧隔离、启动/握手错误、V4 订阅初始快照与断线恢复、command 重试幂等、同 workspace 多 session 路由、并发读取/命令边界、独立 DB 路径、未知 kind 的旧 App 过滤，以及 Host 退出后的子进程清理。fixture 必须对应固定上游版本；真实 CLI 不存在时只能报告自动化验证，不能报告端到端已通过。

## 实施 tickets

每个 ticket 使用独立提交，只暂存该 ticket 的文件；不包含同一工作树中其他任务的变更。

| Ticket | 范围 | 完成条件 |
| --- | --- | --- |
| ZCODE-01 | 本 ADR 与领域词汇 | 决策边界、DB 隔离理由、上游版本和 ticket 划分可复核。 |
| ZCODE-02 | Protocol `AgentKind`、Host feature negotiation/filter 与 iOS/Android 的 `agent.zcode` 能力、kind 识别 | 新 kind 在支持设备可解析；未声明 feature 的旧设备观测不到任何 ZCode runtime/state/catalog/backend。 |
| ZCODE-03 | Host ZCode CLI 发现、独立 DB 路径、stdio V4 transport、进程生命周期与会话激活 | 仅启动受支持 CLI；失败隔离；不触碰默认 Desktop DB；进程退出/Host dispose 正确清理。 |
| ZCODE-04 | V4 session catalog/history/state、输入/停止/交互等与 Orbis model 的逐项映射 | 每项声明的能力有 fixture 测试；未实现能力不进入 UI 菜单；snapshot/delta gap 可恢复。 |
| ZCODE-05 | 跨端兼容回归、支持说明与真实 CLI 验收记录 | Windows 工具链自动测试通过；新旧客户端过滤回归通过；真实 CLI 未安装时明确标为待验收。 |

## 验证状态

当前仅完成 ADR 与上游固定版本的静态源码调查；Host 适配、客户端能力声明、自动化 fixture 和真实 CLI 联调尚未完成。实现过程不得把本节状态提前改为“已验证”。