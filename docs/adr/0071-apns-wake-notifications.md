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
