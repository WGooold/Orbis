# ADR-0009：Relay 的端到端加密路由边界

Status: accepted

旧电脑主动推送要求 Relay 持有用户文件、持久化进度并接收设备明文 ACK，与 Relay 零知识路由的边界冲突；这条路径已删除。文件取用改由手机请求 Host 就地读盘并端到端加密，见 [ADR-0005](0005-receiver-driven-range-download.md)；手机上传见 [ADR-0012](0012-receiver-driven-upload.md)。

## 决策

- Relay 认证 Host，并管理认证与不透明路由；业务命令、会话和文件内容统一经过 E2E。边界错误码为 `runtime_role_not_allowed` 与 `runtime_event_not_allowed`。
- Pi 扩展连接本机 Host loopback；Host 离线时等待并重新读取发现文件。
- 文件投递由 Host 提供端到端能力。`registerRemoteArtifact` / `createRemoteArtifactMessage` 用于生成可点击的下载卡片。

## 实现与验证入口

[Relay](../../packages/relay/src/index.ts)、[Pi loopback](../../packages/pi-extension/src/loopback.ts)、[下载服务](../../packages/host/src/artifact-download.ts)、[协议边界测试](../../packages/protocol/src/index.test.ts)、[Relay 测试](../../packages/relay/src/relay.test.ts)。协议兼容按 [ADR-0064](0064-protocol-compatibility.md)。
