# ADR-0009：Relay 不承载明文命令或托管文件

Status: accepted

旧电脑主动推送要求 Relay 持有用户文件、持久化进度并接收设备明文 ACK，与 Relay 零知识路由的边界冲突；这条路径已删除。文件取用改由手机请求 Host 就地读盘并端到端加密，见 [ADR-0005](0005-receiver-driven-range-download.md)；手机上传见 [ADR-0012](0012-receiver-driven-upload.md)。

## 决策

- Relay 的 runtime 认证只接受 `role: host`；其他角色报 `runtime_role_not_allowed`，明文 `runtime.event` 报 `runtime_event_not_allowed`。Pi 扩展只连接本机 Host loopback；Host 不在线时等待并重新读取发现文件，不回落到 Relay 广播会话。
- 设备明文面仅用于认证与配对 / 加密信封，不提供 `runtime.command` 或文件进度命令。业务命令、会话和文件内容均在 E2E 内，Relay 仅读取认证和路由所需的外壳。
- 不恢复 `runtime.push.*`、`artifact.push.*`、Relay 推送队列、文件数据目录、`transferRoutes` 或原始二进制文件路由。Relay 不持久化用户文件，不解释 Session、传输完成或操作结果。
- Pi 的 `registerRemoteArtifact` / `createRemoteArtifactMessage` 保留，用于生成手机可点击的下载卡片；它们不主动投递文件。以后若新增主动投递，须由 Host 通过 E2E 提供，不能恢复 Relay 托管方案。

## 实现与验证入口

[Relay](../../packages/relay/src/index.ts)、[Pi loopback](../../packages/pi-extension/src/loopback.ts)、[下载服务](../../packages/host/src/artifact-download.ts)、[协议边界测试](../../packages/protocol/src/index.test.ts)、[Relay 测试](../../packages/relay/src/relay.test.ts)。协议兼容按 [ADR-0064](0064-protocol-compatibility.md)，兼容不放宽上述安全边界。
