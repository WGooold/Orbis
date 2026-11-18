# ADR-0089｜OpenClaw Gateway 接入

- 日期：2026-11-19
- 状态：分阶段实施；未发布，用户验收待完成
- 范围：OPENCLAW-01（#39）、OPENCLAW-02（#40）、OPENCLAW-03（#41）
- 关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0064](0064-protocol-compatibility.md)、[ADR-0072](0072-session-configuration-and-recoverable-launch.md)

## OPENCLAW-01｜连接所有权与授权

Host 是 OpenClaw Gateway 的独立 operator 客户端，不启动或停止 Gateway，不读取 OpenClaw 的配置、会话库或其他客户端的身份。App 和 Relay 不直连 Gateway，也不接收 Gateway 凭据。使用 [官方 SDK](https://github.com/openclaw/openclaw/tree/v2026.11.5/packages/gateway-client) 与协议包 `2026.11.5`，按 Gateway 的 operator wire `4` 握手并检查必要 RPC。此版本与 Orbis 业务协议独立；不尝试降级至旧 Gateway wire，也不通过 CLI 包装、浏览器注入或读写原生数据库取代 RPC。

首版仅允许显式配置的 `127.0.0.1`／`[::1]` Gateway 根地址。稳定 Ed25519 设备身份和 Gateway 签发的配对 token 按端点分开保存到 Host 的状态目录，不复用手机配对密钥。使用 Gateway 的共享认证 token，必要时由用户在 Gateway 批准请求。共享 token 握手不保证签发设备 token；只有 Gateway 实际签发且后续独立认证成功，才能去掉共享 token。只申请 `operator.read`／`operator.write`；不请求 admin、approvals、questions 或 pairing。真实 Gateway 上，只有 `operator.sessions.read/write` 的普通 operator 握手可成功，但会话 RPC 因没有已验证用户资料被拒；不因此提升至 admin。

实现：[`openclaw-gateway.ts`](../../packages/host/src/openclaw-gateway.ts)。验证：[`openclaw-gateway.test.ts`](../../packages/host/src/openclaw-gateway.test.ts)（签名、配对 token、拒绝缺 scope／不安全地址）；隔离 Gateway `2026.11.5` 的证据在 `.artifacts/openclaw-20261119/gateway-sdk-smoke.log`。

启用时在 Host 状态目录（默认 `~/.orbis`）提供仅当前用户可读写的 `openclaw-gateway.json`，字段为 `url` 与可选的 `token`，或从启动环境提供 `ORBIS_OPENCLAW_URL` / `ORBIS_OPENCLAW_TOKEN`。环境中的 URL 不继承文件里的 token；将 `ORBIS_OPENCLAW_URL` 设为空可显式禁用。移除该配置并重启 Host 可回退，不改 OpenClaw 的会话或设置。

## OPENCLAW-02｜会话路由与兼容

仅在 Gateway 确认会话访问后公告 OpenClaw。目录保留 Gateway 的活动／归档区分。Orbis 会话 ID 绑定端点、原生键和会话身份；断线后重新订阅原会话，生成新的 runtime ID，不能把同键下重新创建的原生会话接到旧身份上。历史按 Gateway 的消息发生 ID 和锚定游标接入现有可恢复同步，流式文本由已知 turn 驱动，序号缺口由原生历史对账。不按相同文本合并消息。初版投影文本及思考文本，不投影原生工具参数、附件或本机文件能力；工作目录仅用于展示、目录分组和新建参数，不作为读取本机 Git 或启动文件变更采集的依据。

新建复用 ADR-0072 的可恢复启动，采用 Gateway 当前默认配置，使用独立 Host 启动账本，旧 Host 回退继续读原账本。请求持久化后才创建，回执未知时只按原键、原目录和同一 Gateway 查找，不自动重建。首句等待成功的启动回执；发送回执仅证实 Gateway 已受理，不代表模型已回复。已写出但未确认的命令不自动重发，按原生消息标识核对；停止限于已确认的 run。归档与恢复使用原生确认，不代管 OpenClaw 的模型、权限和供应商。

Orbis 18／19 业务版本不变。通过既有 `hostFeatures` 字符串列表公告 `agent.openclaw`，仅给声明该能力的 App 返回新的 `deviceFeatures` 回显及 OpenClaw 数据；该声明不等于 `agent.dshDesktop`。重握手恢复过滤，旧端继续获得可解析的 ready、状态、目录与分页游标，不接受其指向 OpenClaw 的请求。Relay 仍只转发原有会话密文。OpenClaw 不进入未协商的推送与 Live Activity 投影，旧 Relay 的严格 Agent 枚举保持可用。桌面 QA Host 不继承用户的真实 Gateway 配置。

实现：[`openclaw-backend.ts`](../../packages/host/src/openclaw-backend.ts)、[`openclaw-history.ts`](../../packages/host/src/openclaw-history.ts)、[`dsh-desktop-visibility.ts`](../../packages/host/src/dsh-desktop-visibility.ts)。自动验证：[`openclaw-backend.test.ts`](../../packages/host/src/openclaw-backend.test.ts)、[`host-protocol-compatibility.test.ts`](../../packages/host/src/host-protocol-compatibility.test.ts)、[`dsh-desktop-visibility.test.ts`](../../packages/host/src/dsh-desktop-visibility.test.ts)。`.artifacts/openclaw-20261119/` 保留 Host 与协议回归、`release-schema-matrix.log`（`v0.1.22` / `android-v0.1.60` 发布 tag 的严格协议解析及未过滤负对照，非旧包设备测试）、`backend-real-smoke-first.log`（隔离 Gateway：目录、创建、订阅、发送受理、历史对账、归档与恢复）。该 Gateway 没有可用模型，真实 turn 返回失败；成功流式回复和定向停止仅有合成测试证据。

部署：未发布，未修改用户 Host、Relay 或 OpenClaw。设备／用户验收：待用户验证。
