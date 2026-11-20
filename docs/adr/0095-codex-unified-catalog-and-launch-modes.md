# ADR-0095：Codex 统一会话目录，启动方式独立

日期：2026-11-20

状态：实现中；Host 与 iOS／Android 首轮实现及定向自动验证已完成；旧版本兼容门禁、全量审查、部署与用户验收待完成。

关联：[ADR-0021](0021-codex-terminal-host-attachment.md)、[ADR-0022](0022-codex-desktop-daemon-attachment.md)、[ADR-0025](0025-native-history-authority-and-versioned-caches.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0069](0069-session-catalog-and-bounded-history-loading.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)、[ADR-0094](0094-host-agent-enablement.md)。

## 背景

当终端和桌面使用同一份原生 Codex 历史时，两边的 `thread/list` 都可以看到同一个已保存的会话。`thread/loaded/list` 则只报告某个 app-server 当前已加载的线程，不能回答这条会话最初在哪里创建，也不覆盖未加载的历史。既有验证见 [ADR-0021](0021-codex-terminal-host-attachment.md) 的共享历史修订及[原生接口对照测试](../../packages/host/src/codex-session-source-native.test.ts)。

现有 Orbis 将桌面接入时确认的 ID 写入 `codex-desktop-threads.json`；桌面目录只保留名单里的条目，终端目录反向排除。新 Host 没有这份归属记录时，Codex 桌面自己能看到、但未加载的旧会话可能被 Orbis 放进终端目录；终端后端未就绪时，这条记录在手机上可能完全不可见。缺口在目录分类，不是原生历史以配对时间为界。见 [Codex 目录过滤](../../packages/host/src/codex-runtime.ts)与[Host 目录聚合](../../packages/host/src/host-service.ts)。

## 决策

### CODEX-UNIFIED-01｜一个 Codex 目录

- iOS 和 Android 只提供一个 **Codex** 会话目录及新建入口。会话继续按所选 Host 和项目组织，保留搜索、归档和模型供应商筛选；不按桌面／终端、创建入口或上次打开方式分栏或筛选。
- Host 以原生持久历史为目录权威。只要任一已启用的路径能读取该历史存储，就按同一规则列出普通和归档会话，包括接入前已保存但未加载的会话。目录读取不启动后端、不打开窗口、不恢复线程；原生读取不完整或暂不可用时，保留已核对的缓存并报告覆盖状态。目录仍按 ADR-0069 按需分页，不随目录下载聊天正文。
- 会话身份由 **Host、已核对的原生历史存储域、原生 `threadId`** 决定。共享同一存储域的同 ID 只显示一次；切换打开方式不会改变这一身份。不同 Host、不同或尚不能确认相同的原生历史存储（如不同 `CODEX_HOME`）不合并，不按标题或工作目录猜测。App 使用 Host 给出的会话身份，不自行解析本机存储路径。
- `source`、`originator`、`thread/loaded/list` 和旧桌面名单不再决定会话在统一目录中的可见性。保留对临时线程、子代理以及确认为无会话内容的被动空草稿的排除。

### CODEX-UNIFIED-02｜桌面和终端只决定怎么启动

- 新建或恢复未运行的会话时，「桌面」「终端」是启动方式。App 只提供 Host 确认可用的方式；恢复时还须能访问该会话的原生历史存储。未指定方式时，可沿用当前 Host 的有效用户偏好或使用唯一可用方式，否则由用户选择。恢复使用原生 `thread/resume` 和原 `threadId`，不是新建或复制对话。已有运行连接且未请求切换时，继续使用该连接。配置式启动的持久账本将启动方式纳入不可变启动指纹，崩溃恢复沿用首次记录的来源。
- Host 保留两条独立的原生接入和各自的启用状态。安装、启用、可启动、已连接继续按 ADR-0094 区分。所选方式不可用时报告原因，不在后台改用另一方式。桌面／终端的运行入口与已有 `spawnMode`（开窗或无头）是不同维度；保留终端支持的无头形态，不把它变成另一类会话。
- 同一会话的正在运行回合、待回复审批与发送仍归当前已确认的运行时。`thread/loaded/list` 用于发现运行时，不赋予目录归属；看到某线程已加载也不等于确认它持有写入权。要求改用另一方式时，须先确认原写入者已释放，才能在目标路径恢复；如果仍在运行、等待用户输入或归属不明，不抢占、不关闭原生客户端、不自动重发，也不创建第二个写入者。
- 读更早消息沿用原生历史核对与手机按页同步。归档／取消归档作用于同一个原生会话，不因启动方式维护两份，也不为归档而启动会话。新建与恢复沿用 ADR-0072 的单次启动身份、配置对账和断线恢复约束。

### CODEX-UNIFIED-03｜兼容与迁移

- 按 ADR-0064 为统一目录与独立启动方式协商能力；注册、目录、后续事件及操作回执使用同一设备投影。未协商时，新 Host 继续向旧 App 提供旧 `codex`／`codexDesktop` 目录与 ID 路由；新 App 对旧 Host 沿用旧读写路径，不假定旧 Host 能提供统一库存。Relay 不承担会话分类或迁移。
- 旧裸 `sessionId` 与 `codex-desktop:<threadId>` 只在 Host 核对属于同一份原生历史时映射到同一会话。保留兼容别名和旧缓存以支持回退；只有身份和历史版本均匹配时才复用已验证覆盖，否则从原生来源重对账。草稿按核对过的会话身份关联并保留冲突内容；在途发送、审批、启动回执仍以原操作和运行时身份对账，不因合并目录而重放。
- 协商生效后，本 ADR 替代 ADR-0021／0022 中按归属拆分 **App 会话目录**的规则；保留原生接入、实时命令路由和写入保护。旧名单留给兼容投影，不是新目录的依赖。其它 Agent 的会话目录及 VS Code 接入不在本次范围内。

## 验证与交付

| 场景 | 验收判定 |
| --- | --- |
| CODEX-UNIFIED-01 | 新 Host 无桌面归属名单，仅接入桌面且终端未启动：未加载的旧对话已在统一目录中；仅终端就绪时同样可见。双路同存储只显示一条，不同存储／Host 不合并；归档、搜索和有界分页保持原有语义。 |
| CODEX-UNIFIED-02 | 同一旧对话分别从桌面、终端恢复，原生 ID 和旧正文不变；目录读取不开窗。已有写入者时不会再启动写入或新建副本；不可用、断线、重复请求不换路、不重复发送。 |
| CODEX-UNIFIED-03 | 最近已发布的真实旧 App／Host／Relay 与新端互通，对照新端同版组合；验证能力降级、重连与回退，目录、历史、草稿及原操作回执不会串到另一会话。 |

## 实现进度（2026-11-21）

已接入首轮实现：Host 双路目录聚合与 `codex-history:<sha256>` 身份、按已核对存储域路由、旧协议视图降级、统一目录分页／搜索／归档、启动方式与 `spawnMode` 分离，以及配置启动账本持久化启动方式。iOS 和 Android 已协商统一目录、以统一身份选择目录记录与历史缓存、按可用模式恢复，并保留旧端回退投影。缺少可信存储身份时使用逐连接隔离，不把不同 `CODEX_HOME` 或不可核对的端点合并。

代码与回归指针：[codex-history-catalog.ts](../../packages/host/src/codex-history-catalog.ts)、[host-state-facts.ts](../../packages/host/src/host-state-facts.ts)、[host-service.ts](../../packages/host/src/host-service.ts)、[session-configuration-store.ts](../../packages/host/src/session-configuration-store.ts)、[SessionHistoryStorage.swift](../../ios/Orbis/Orbis/SessionHistoryStorage.swift)、[OrbisStore.swift](../../ios/Orbis/Orbis/OrbisStore.swift)、[RemoteState.kt](../../android/app/src/main/java/com/orbising/orbis/RemoteState.kt)、[HostConnection.kt](../../android/app/src/main/java/com/orbising/orbis/HostConnection.kt)。

本轮定向自动验证：`npm run typecheck` 通过；Host catalog／launch／加密链路定向测试 18 项通过；Codex runtime / desktop 测试 258 项通过；HostService 测试 110 项通过、2 项跳过；Swift `SessionHistoryTests` 18 项通过；Android 四个定向单测类共 39 项通过。原始记录见 `.artifacts/codex-unified-20261121/`。这些结果不代表全部 App／Relay 兼容门禁或用户验收已完成。

尚未完成：最近发布版本的真实旧 App／Host／Relay 互通与回退核对、双路运行时占用冲突的完整恢复矩阵、旧缓存／草稿别名的冲突处置审查、完整 iOS／Android 产品构建与设备验收、部署。设备验收由用户完成。
