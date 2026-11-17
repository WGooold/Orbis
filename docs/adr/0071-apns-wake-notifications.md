# ADR-0071：APNs 仅提醒推送与端到端状态恢复

Status: proposed

## 多电脑、多手机的提醒与来源展示（2026-11-18，SC111–SC114）

本节设计先于实现落定。沿用 S61 的实时活动、现有通知权限与配对关系；一个 Host 的不同手机分别判定提醒，一部手机的不同 Host 分别展示。实现、自动验证、部署及人工验收分别记录。

### SC111：实时活动的来源与层级（LA-I11）

- 每个 Host 保持一个聚合活动，不把不同电脑的任务合成一个总数。锁屏与展开视图首先显示电脑名，其后显示任务标题、运行／待处理数量；数量只属于这台电脑。Agent 图标保留在任务信息中，不能代替电脑来源。
- 紧凑态左侧为电脑短名，右侧为现有耗时／数量／待处理状态；最小态使用本机生成的简短来源标记，VoiceOver 读出完整电脑名与状态。同名或截断后相同的来源使用稳定的 Host 摘要后缀区分，颜色仅表达状态。长名称单行截断，不能挤掉状态。
- 待处理活动的 relevance 高于普通运行活动，过期／结束最低；最终展示数量和位置交由 iOS 决定，不轮播抢占，也不承诺所有 Host 同时占据灵动岛。系统不允许新活动时继续保留普通提醒。
- 电脑名及来源标记保存在本机 activity attributes，兼容缺少新增字段的旧活动；旧活动使用通用电脑名与 Host 摘要兜底。活动创建后的改名在下一次活动生效，不为改名重建当前活动。现有过期、终态、划掉抑制与点击校验保持有效。

### SC112：通知中心的分组与隐私（APNS-L17）

- 每条提醒都显示来源电脑。标题为电脑显示名，正文为“任务已完成”或“有待处理的审批”；已有本地会话标题作为副标题。相同电脑名将稳定短标记放在开头，例如“7C2A · Mac mini”，避免长名称截掉区分标记。通知按 Host 分组，事件身份继续由 Host＋类别＋事件区分，两个 Host 的相同会话／事件 ID 不能互相覆盖。
- 远程 alert 只携带既有 Host、类别及事件标识。新增 Notification Service Extension 从 App Group 中的本机来源目录补齐电脑名与语言；目录只含展示信息与不透明配对指纹，不含 credential、密钥、聊天内容或 APNs token。App 在配对新增、改名、解除时异步原子更新目录。
- Relay 加入标准 APNs `thread-id`、`mutable-content`；扩展不可用、执行超时、目录缺失或旧 App 时保留“Orbis／电脑短标记＋通用提醒”的可用兜底。扩展不访问网络，不代替 E2E 状态核对。App Group 与扩展需在签名配置中一致启用，真实签名及 APNs 展示属于设备验证。

### SC113：逐手机路由（APNS-L18／L19）

- 完成／待处理事件按每台未撤销手机判断。正在接收该会话的手机走原 E2E 更新；查看另一会话、另一 Host、首页或后台的手机走 APNs。某手机的前台状态不改变其他手机的提醒。
- 已保留的 E2E 会话与实际可达性分开。Relay 的 `device_offline` 不能被 `active` 路径掩盖；不通过销毁会话修正提醒，仍保留原重连恢复行为。当前可见会话在发送事件后通过有界加密探测确认通路；探测失败／超时则回退 APNs，覆盖先完成、后收到离线回报的竞态。
- 未声明 history interest 的旧 App 沿用可达时 E2E、不可达时 APNs。去重记录针对同一事件，路由判断为每台手机独立；推送仍是尽力提醒，不承诺系统级可靠投递或跨通道严格一次。前台正在阅读对应会话时不额外弹本地完成横幅。

### SC114：通知点击与安全落点（APNS-L20）

- 本地及远程通知使用同一保留式点击队列，支持冷启动。兼容既有顶层 `hostId/sessionId` 的本地通知和 `orbis.v=1` 远程通知。
- 新本地通知携带本机配对指纹及会话 ID；先验证当前配对，再仅在当前映射确认该会话时进入。远程提醒不携带会话内容，打开对应电脑首页；本地目标会话消失时也回该电脑首页，不进入该电脑之前记住的另一个会话。已解除或已替换配对的新通知被丢弃，旧格式只能按其已有 Host 信息校验。
- 本轮实现范围为 Host／Relay 路由、iOS APNs、本地通知与实时活动；Android 不具有本轮 APNs／ActivityKit 通道，其独立通知能力另行演进。

兼容边界：不改变 E2E 版本、业务帧及注册／wake 请求字段；APNs 扩展键为系统标准字段，旧 App 仍能显示提醒；新增本地 attributes 字段为可缺省值。旧 Relay 的通知没有 `mutable-content`，继续显示原通用提醒；旧 Host 继续使用原路由，新展示与修复分别随相应组件升级生效。

实现入口：Host `DeviceLink.confirmNotificationReachability` 与 `HostService` 的逐设备 wake；Relay `APNsSender`；iOS `NotificationSource.swift`、`PushRegistration.swift`、`Notifications.swift`、`NotificationService/` 及原实时活动组件。回归见 `device-link.test.ts`、`host-service.test.ts` 的 APNS-L18／L19、`apns-transport.test.ts`、`NotificationSourceTests`、`PushRegistrationTests`、`LiveActivityPresentationTests`。

2026-11-18 本机实施与自动验证完成：Node 定向验证 92 项通过；Swift 定向验证与独立发布版互通共 32 项通过；TypeScript 检查及 iOS App／Widget／通知扩展的 arm64、x86_64 编译通过。覆盖 2 Host × 2 手机、仅一台手机断开／切换、事件与离线反馈竞态、旧 App 无 interest、相同 Host 名及相同事件 ID、点击冷启动和完整配对替换。最近发布 v0.1.21 的真实 Relay 与 Swift 点击解析器通过注册、重连、回退和新通知包对照；E2E schema 与设备协议源码哈希保持一致。原缺陷证据保留于 `.artifacts/push-multihost-audit-20261117/`，本轮结果、首次失败及清理证据见 `.artifacts/push-multihost-fix-20261118/verification.json`。未部署、未安装到设备；App Group／扩展签名、真实 APNs 投递和灵动岛观感待用户验证。共享 QA MCP 当前连接被拒绝，登记请求条件与本轮完整验收要求保留在同目录 `qa-registration.json`；尚未建立可领取轮次。

## iOS 实时活动（2026-11-17，S61／SC109）

- 每个 Host 聚合一个实时活动：单会话显示静态 Agent 图标与上次确认的约分钟耗时，多会话显示数量；待处理请求优先，展开显示焦点会话及其余运行数量。静止状态无旋转、闪烁或秒计时，过期显示待更新，结束后退出灵动岛并在锁屏短留。
- App 在前台且系统允许时创建，后台由独立 ActivityKit 推送更新。普通变化合并 30 秒，活跃摘要每 4 分钟低优先级续鲜、10 分钟过期；新增待处理与末态优先更新。关闭或未知库存只标过期，只有来源明确 completed 才显示完成。首版未接入 push-to-start。
- `/v1/live-activities/config`、`register`、`update` 与旧 alert 通道独立。推送只包含通用状态、数量、Agent 类别、不透明焦点键与时间；标题只保留在本机 attributes，焦点不匹配时显示通用标题。手机不因实时活动获得后台保活。
- 注册按完整配对与活动身份串行对账；Keychain 保留清理归属，不缓存推送 token。旧活动清理、令牌轮换、配对撤销与迟到失效响应不会删除新注册。Host 发布者绑定 Relay 当前认证连接与递增版本，旧 Relay 不支持时静默回退；已发布 Host、Relay、App 的原 HTTP 与 E2E 字段保持兼容。
- 用户划掉活动后，同轮所有运行代次的抑制记录跨 App 重启保留；聚合焦点变化或补齐开始时间不会重建同轮活动。点击仅导航，重新核对完整配对与当前会话后进入 App，不在锁屏回答审批。
- SC110／LA-I09：点击等待当前路由最多两秒；当前映射已确认目标会话时直接进入，其余库存的待核对状态不阻塞该会话。超时或完整映射确认目标已消失时回到对应电脑首页并消费目标；进入后台、用户导航或新点击会清理或替换旧意图，迟到对账不再跳转。回归见 `LiveActivityOpenQueueTests`，本轮自动验证、构建与共享 QA 登记状态分别记录于 `.artifacts/ios-review-fixes-20261117/`；真机体验待用户验证。

实现入口：iOS `LiveActivityAttributes.swift`、`LiveActivityCoordinator.swift`、`LiveActivityRegistration.swift`、`LiveActivityLifecycle.swift` 与 `LiveActivityWidget/`；Host `live-activity.ts`；Relay `live-activities.ts` 与 `apns.ts`。定向回归见对应 `LiveActivity*Tests.swift`、`live-activity.test.ts`、`live-activities.test.ts`、`live-activity-http.test.ts` 和 `apns-transport.test.ts`；实际执行记录与首次编译失败保留在 `.artifacts/ios-live-activity-20261117/`。本轮仅本机实施与自动验证；未部署，签名安装与真实 APNs／真机体验待用户验证，共享 QA 登记状态以该目录记录为准。

## 决策

- 为 iOS 增加 APNs alert 提醒，覆盖 Host 观察到的任务正常完成、出现待审批两种低频边缘事件。推送只携带类别和随机/稳定事件标识，不包含聊天正文、审批参数、密钥或回答动作；APNs/Relay 均不是业务状态权威。
- Host 按 SC113 对每台手机的会话关注范围及实际通路判定 Relay wake；保留的 E2E 会话不等于手机可达。Relay 校验已认证 Host 的 credential 与当前 Host 身份匹配、设备必须绑定到该 Host，再向 APNs 投递。收到通知后由用户打开 App，通过既有 E2E transport 获取 Host 权威状态。推送不作可靠投递承诺。
- iOS 使用配对的 Relay device credential 注册 APNs token；设备撤销时由 Relay 清理 token。token 按 Host 配对作用域保存，Relay 状态文件权限为 0600。APNs .p8 仅由 Relay 进程从密钥文件读取。
- 这不是 ADR-0009 中已删除的电脑到手机业务推送恢复：不传文件/会话内容、不保存投递进度、不需要手机明文 ACK；Relay 仍不解析 E2E 帧。

## Relay 配置

设置 `ORBIS_APNS_KEY_ID`、`ORBIS_APNS_TEAM_ID`、`ORBIS_APNS_BUNDLE_ID=com.orbising.orbis.ios`、`ORBIS_APNS_PRIVATE_KEY_FILE`（指向私有 `.p8` 文件）与 `ORBIS_APNS_ENVIRONMENT=sandbox|production`（旧部署也可使用 `PI_REMOTE_` 前缀）。`sandbox` 用于开发签名；TestFlight/App Store 分发使用 `production`。Relay 状态文件目录应仅 Relay 服务账号可读写；不要把 .p8 加进仓库、镜像或日志。

同时服务本地开发签名与 TestFlight 时，保留 `ORBIS_APNS_ENVIRONMENT=production` 及原有密钥作为旧客户端默认值，另设 `ORBIS_APNS_SANDBOX_KEY_ID` 与 `ORBIS_APNS_SANDBOX_PRIVATE_KEY_FILE`。sandbox 默认复用相同 Team／Bundle ID，也可分别设置 `ORBIS_APNS_SANDBOX_TEAM_ID`／`ORBIS_APNS_SANDBOX_BUNDLE_ID`。两类目的地分别使用相应环境的密钥与 Apple 端点；新建环境限定密钥不能跨环境复用。

Apple Developer 中需为 `com.orbising.orbis.ios` App ID 启用 Push Notifications，更新开发/分发 provisioning profiles，并用相同 Team 签名。推送环境随签名 entitlement：`development` 对应 sandbox，`production` 对应 production；本地开发签名的 Release 优化包同样使用 sandbox。普通 alert 不启用 Background Modes / `remote-notification`。

## 实现与验证入口

APNs sender、Relay 注册/唤醒接口：[packages/relay/src/apns.ts](../../packages/relay/src/apns.ts)、[packages/relay/src/index.ts](../../packages/relay/src/index.ts)；Host 语义边缘触发：[packages/host/src/host-service.ts](../../packages/host/src/host-service.ts)；iOS 注册：[ios/Orbis/Orbis/Notifications.swift](../../ios/Orbis/Orbis/Notifications.swift)。配置实际可用性和签名结果必须用真实 .p8、Apple Developer profile、真机分别验证；单测不证明 APNs 服务端投递或 Apple capability 生效。

## 生命周期修订（2026-11-13）

- APNS-L01／L02：Relay 串行提交 token 变更、持久化与失败回滚；请求体接收后重新校验配对凭据。设备撤销及停用优先于旧推送文件；APNs 旧请求的失败响应不得删除更新后的注册。同一 Host 的同一 token 在一次 wake 中只投递一次。
- APNS-L03–L08：iOS 按完整配对端点协调注册。每次进程启动等待新的 APNs 回调；新增、删除、替换 Host 配对与通知权限变化分别对账。离线解除配对的清理任务保存在 Keychain，重启后继续；前台及网络恢复重新对账。旧请求结束后才提交新意图，暂时失败采用有上限的退避间隔。
- APNS-L09／L10：Host 对同一完成或审批事件保留有界去重记录。APNs 提醒有效期为五分钟，collapse ID 包含 Host 与事件类别；永久失效的目的地被清理，提供者认证错误与暂时失败保留注册。连接关闭及 GOAWAY 后重新建立传输。
- APNS-L11：通知点击先保存 Host，再由界面订阅消费；冷启动不依赖瞬时广播。
- APNS-L12／L14：新版 App 注册前访问已认证的 `/v1/push/config`，仅在版本与 sandbox／production 环境匹配后上传 token；旧 Relay 返回 404 时停用远程注册。清理请求独立执行。新版 Relay 保留旧 App 的 token-only 格式与 version 1 状态文件兼容；HTTP 重定向不携带凭据继续请求。
- APNS-L13：模拟器使用独立 QA App ID、随机 Keychain 命名空间与合成配对，实际执行重启、卸载／重装、全新安装和系统通知注入。注入成功不代表 Apple APNs 投递成功。
- APNS-L15（2026-11-16）：构建从 `CODE_SIGN_ENTITLEMENTS` 生成包内推送配置，注册不再按 Debug／Release 推断环境；缺失或无效配置时停止 token 注册，解除配对及撤销权限仍可清理旧注册。交付包与导出后重新签名包须通过 [ios-push-environment.py](../../scripts/ios-push-environment.py) 的 `verify` 检查，确认包内配置与最终签名一致；回归见 [test_ios_push_environment.py](../../scripts/test_ios_push_environment.py) 和 `PushRegistrationTests`。
- APNS-L16（2026-11-16）：App 在 `/v1/push/config` 查询自身签名对应的 `environment`；响应保持 version 1 的原有字段。Relay 仅接受已启用环境的注册，按持久化的设备环境选择 APNs sender，以环境和 token 共同去重。旧 App 的无查询请求及 token-only 注册仍使用默认环境；旧 Relay 忽略查询时继续由原匹配检查决定是否注册。

回归入口：[PushRegistrationTests.swift](../../ios/Orbis/Tests/PushRegistrationTests.swift)、[PushLifecycleProbe.swift](../../ios/Orbis/DeviceTests/PushLifecycleProbe.swift)、[push-lifecycle.test.ts](../../packages/relay/src/push-lifecycle.test.ts)、[apns-transport.test.ts](../../packages/relay/src/apns-transport.test.ts)、[push-wake.test.ts](../../packages/host/src/push-wake.test.ts)。

自动验证与首次失败证据保存在 `.artifacts/apns-lifecycle-20261113/`：`reinstall-5/summary.json` 记录模拟器实际安装生命周期，`compatibility/` 使用 v0.1.19 原始 Relay／协议源码与新版 Swift HTTP 客户端验证回退及同版正对照。实现、自动验证、部署和人工验收分别记录；本次未部署，真实 APNs 投递及真机权限／重装路径待用户验证。
