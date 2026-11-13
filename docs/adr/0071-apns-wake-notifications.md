# ADR-0071：APNs 仅提醒推送与端到端状态恢复

Status: proposed

## 决策

- 为 iOS 增加 APNs alert 提醒，覆盖 Host 观察到的任务正常完成、出现待审批两种低频边缘事件。推送只携带类别和随机/稳定事件标识，不包含聊天正文、审批参数、密钥或回答动作；APNs/Relay 均不是业务状态权威。
- Host 仅对当前没有可用 E2E HostDeviceSession 的已配对设备发送 Relay wake 请求。Relay 校验已认证 Host 的 credential 与当前 Host 身份匹配、设备必须绑定到该 Host，再向 APNs 投递。收到通知后由用户打开 App，通过既有 E2E transport 获取 Host 权威状态。推送不作可靠投递承诺。
- iOS 使用配对的 Relay device credential 注册 APNs token；设备撤销时由 Relay 清理 token。token 按 Host 配对作用域保存，Relay 状态文件权限为 0600。APNs .p8 仅由 Relay 进程从密钥文件读取。
- 这不是 ADR-0009 中已删除的电脑到手机业务推送恢复：不传文件/会话内容、不保存投递进度、不需要手机明文 ACK；Relay 仍不解析 E2E 帧。

## Relay 配置

设置 `ORBIS_APNS_KEY_ID`、`ORBIS_APNS_TEAM_ID`、`ORBIS_APNS_BUNDLE_ID=com.orbising.orbis.ios`、`ORBIS_APNS_PRIVATE_KEY_FILE`（指向私有 `.p8` 文件）与 `ORBIS_APNS_ENVIRONMENT=sandbox|production`（旧部署也可使用 `PI_REMOTE_` 前缀）。`sandbox` 用于开发签名；TestFlight/App Store 分发使用 `production`。Relay 状态文件目录应仅 Relay 服务账号可读写；不要把 .p8 加进仓库、镜像或日志。

Apple Developer 中需为 `com.orbising.orbis.ios` App ID 启用 Push Notifications，更新开发/分发 provisioning profiles，并用相同 Team 签名。Debug 使用 `aps-environment=development`，Release 使用 `production`。普通 alert 不启用 Background Modes / `remote-notification`。

## 实现与验证入口

APNs sender、Relay 注册/唤醒接口：[packages/relay/src/apns.ts](../../packages/relay/src/apns.ts)、[packages/relay/src/index.ts](../../packages/relay/src/index.ts)；Host 语义边缘触发：[packages/host/src/host-service.ts](../../packages/host/src/host-service.ts)；iOS 注册：[ios/Orbis/Orbis/Notifications.swift](../../ios/Orbis/Orbis/Notifications.swift)。配置实际可用性和签名结果必须用真实 .p8、Apple Developer profile、真机分别验证；单测不证明 APNs 服务端投递或 Apple capability 生效。

## 生命周期修订（2026-11-13）

- APNS-L01／L02：Relay 串行提交 token 变更、持久化与失败回滚；请求体接收后重新校验配对凭据。设备撤销及停用优先于旧推送文件；APNs 旧请求的失败响应不得删除更新后的注册。同一 Host 的同一 token 在一次 wake 中只投递一次。
- APNS-L03–L08：iOS 按完整配对端点协调注册。每次进程启动等待新的 APNs 回调；新增、删除、替换 Host 配对与通知权限变化分别对账。离线解除配对的清理任务保存在 Keychain，重启后继续；前台及网络恢复重新对账。旧请求结束后才提交新意图，暂时失败采用有上限的退避间隔。
- APNS-L09／L10：Host 对同一完成或审批事件保留有界去重记录。APNs 提醒有效期为五分钟，collapse ID 包含 Host 与事件类别；永久失效的目的地被清理，提供者认证错误与暂时失败保留注册。连接关闭及 GOAWAY 后重新建立传输。
- APNS-L11：通知点击先保存 Host，再由界面订阅消费；冷启动不依赖瞬时广播。
- APNS-L12／L14：新版 App 注册前访问已认证的 `/v1/push/config`，仅在版本与 sandbox／production 环境匹配后上传 token；旧 Relay 返回 404 时停用远程注册。清理请求独立执行。新版 Relay 保留旧 App 的 token-only 格式与 version 1 状态文件兼容；HTTP 重定向不携带凭据继续请求。
- APNS-L13：模拟器使用独立 QA App ID、随机 Keychain 命名空间与合成配对，实际执行重启、卸载／重装、全新安装和系统通知注入。注入成功不代表 Apple APNs 投递成功。

回归入口：[PushRegistrationTests.swift](../../ios/Orbis/Tests/PushRegistrationTests.swift)、[PushLifecycleProbe.swift](../../ios/Orbis/DeviceTests/PushLifecycleProbe.swift)、[push-lifecycle.test.ts](../../packages/relay/src/push-lifecycle.test.ts)、[apns-transport.test.ts](../../packages/relay/src/apns-transport.test.ts)、[push-wake.test.ts](../../packages/host/src/push-wake.test.ts)。

自动验证与首次失败证据保存在 `.artifacts/apns-lifecycle-20261113/`：`reinstall-5/summary.json` 记录模拟器实际安装生命周期，`compatibility/` 使用 v0.1.19 原始 Relay／协议源码与新版 Swift HTTP 客户端验证回退及同版正对照。实现、自动验证、部署和人工验收分别记录；本次未部署，真实 APNs 投递及真机权限／重装路径待用户验证。
