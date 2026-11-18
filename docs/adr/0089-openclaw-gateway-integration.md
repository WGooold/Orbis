# ADR-0089｜OpenClaw Gateway 接入

- 日期：2026-11-19
- 状态：分阶段实施；未发布，用户验收待完成
- 范围：OPENCLAW-01（#39）、OPENCLAW-02（#40）、OPENCLAW-03（#41）
- 关联：[ADR-0032](0032-unified-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)

## OPENCLAW-01｜连接所有权与授权

Host 是 OpenClaw Gateway 的独立 operator 客户端，不启动或停止 Gateway，不读取 OpenClaw 的配置、会话库或其他客户端的身份。App 和 Relay 不直连 Gateway，也不接收 Gateway 凭据。使用 [官方 SDK](https://github.com/openclaw/openclaw/tree/v2026.11.5/packages/gateway-client) 与协议包 `2026.11.5`，按 Gateway 的 operator wire `4` 握手并检查必要 RPC。此版本与 Orbis 业务协议独立；不尝试降级至旧 Gateway wire，也不通过 CLI 包装、浏览器注入或读写原生数据库取代 RPC。

首版仅允许显式配置的 `127.0.0.1`／`[::1]` Gateway 根地址。稳定 Ed25519 设备身份和 Gateway 签发的配对 token 按端点分开保存到 Host 的状态目录，不复用手机配对密钥。初次连接使用 Gateway bootstrap token，必要时由用户在 Gateway 批准请求。只申请 `operator.read`／`operator.write`；不请求 admin、approvals、questions 或 pairing。真实 Gateway 上，只有 `operator.sessions.read/write` 的普通 operator 握手可成功，但会话 RPC 因没有已验证用户资料被拒；不因此提升至 admin。

实现：[`openclaw-gateway.ts`](../../packages/host/src/openclaw-gateway.ts)。验证：[`openclaw-gateway.test.ts`](../../packages/host/src/openclaw-gateway.test.ts)（签名、配对 token、拒绝缺 scope／不安全地址）；隔离 Gateway `2026.11.5` 的证据在 `.artifacts/openclaw-20261119/gateway-sdk-smoke.log`。
