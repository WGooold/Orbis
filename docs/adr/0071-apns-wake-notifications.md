# ADR-0071：APNs 仅提醒推送与端到端状态恢复

Status: proposed

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
- Host 仅对当前没有可用 E2E HostDeviceSession 的已配对设备发送 Relay wake 请求。Relay 校验已认证 Host 的 credential 与当前 Host 身份匹配、设备必须绑定到该 Host，再向 APNs 投递。收到通知后由用户打开 App，通过既有 E2E transport 获取 Host 权威状态。推送不作可靠投递承诺。
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
