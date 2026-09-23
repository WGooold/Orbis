# ADR-0011 · nonce 槽位与高水位线接收

日期：2026-09-17
状态：已采纳
取代：issue 早期内部设计记录（不包含在公开仓库中） 的建议实现、issue 早期内部设计记录（不包含在公开仓库中） 的决策 (d)

## 背景

序号 `hdr.n` 在加密层承担了两个职责：

1. **nonce 的唯一来源**：`nonce = 0x00000000 ‖ uint64BE(n)`。
2. **通道完整性的判据**：接收侧强制 `hdr.n === last + 1`。

多路复用（ADR-0007）把序号按 channel 各自从 1 开始，这两个职责同时坏掉：

- **职责 1 失守（issue 01）**：ctl 与 bulk 的第 1 帧都是 `n=1` → 同一个
  `(key, nonce)` 加密不同明文。AES-GCM 在 nonce 重用下机密性与认证同时失效，
  实测两条密文异或等于两条明文异或。**每次连接必然发生**，不需要竞态。
- **职责 2 误伤（issue 04）**：任何一条 channel 丢一帧（P2P 的 `send` 返回
  false、片层丢弃半条消息），计数器卡死 → 之后每一帧都被判空洞 →
  这条 channel 永久失效，且只有 trace 日志。

而写入层切片（issue 03 / ADR-0010）让"一条消息只送达一部分"成为**正常结果**，
职责 2 的强约束从"偶尔触发"变成了"必然触发"。

## 决策

**把 `n` 的两个职责拆开，每条道各自声明它需要哪个。**

### 1. nonce 锚定「发送侧封了几次帧」，不锚定「数据身份」

```
nonce[0..3]  = uint32BE(channel 槽位)   1=ctl  2=msg  3=bulk   （0 保留不用）
nonce[4..11] = uint64BE(n)
```

`(ch, n)` 复合键全局唯一 → nonce 不复用。`n` 仍是每条 channel 各自的发送
计数器，发送侧严格 `+1`（不变）。

被否决的替代：issue 04 原定的 `nonce = truncate96(SHA-256(transferId ‖ 0x00 ‖ uint64BE(offset)))`。
否决理由：它把唯一性锚在"数据身份"上，而重传同一 offset 时内容可能已变
（同 nonce 不同明文）；且需要把 `offset` 挪进明文头；且会产出两套 nonce 规则。

### 2. `ch` 纳入 AAD

`canonEnvelopeAad`：`k/room/from/to/n` 五行 → `k/room/from/to/ch/n` 六行。
`ch` 参与 nonce 派生后就是"决定能不能解开"的字段，必须认证。

### 3. 接收侧三条道统一只查高水位线

```
n >  last → 解密、接受、推进
n <= last → 静默丢弃（返回 undefined/null + onStale 计数），不是错误
```

`replay` / `sequence_gap` 两个错误种类删除。丢帧不再毒化通道；
中继也无法用重放把接收方刷进错误处理。

## 后果

- **正面**：issue 01、04 同时消失；"半条消息"成为可接受状态（片层丢弃即可）；
  重发同一条已封好的帧（同 n → 同 nonce 同密文）是安全幂等的，片层重试正是
  需要这个性质；不需要重握手机制。
- **正面（安全）**：防重放强度不变——GCM 标签保证帧来自密钥持有者，攻击者
  构造不出 `n > last` 的帧；中继的重放全部落在水位线以下。
- **负面（可观测性）**：丢帧完全静默。补偿：`onStale` 计数 + 片层 `onRejected`
  计数；端到端兜底不变（交互 `expiresAt`、bulk sha256、会话 `session.sync`）。
- **负面（协议破坏）**：AAD 与 nonce 布局都变了。按 ADR-0008 不做协商：
  `PROTOCOL_VERSION` 4 → 5，旧客户端被硬门槛拒绝。测试向量（`DATA_CT_*`）
  全部重算。

## 实现位置

- TS：`packages/protocol/src/index.ts`（`CHANNEL_SLOT`/`envelopeNonce`/`canonEnvelopeAad`）、
  `packages/e2e/src/session.ts`（`E2eChannel.seal/open`）、`packages/host/src/device-session.ts`
  （`SessionOutcome` 新增 `stale`）、`packages/host/src/device-link.ts`
- Kotlin：`EnvelopeV2.kt`（`EnvelopeV2Contract`）、`HandshakeE2e.kt`（`E2eChannel`）、
  `RelayClient.kt`（`handleE2eEnvelope` 区分「未握手」与「重放」）
- 回归测试：`session.test.ts`（nonce 唯一性、跳号、篡改 ch）、`CryptoTest.aad_and_nonce_canonical_forms`
  （nonce 布局逐字节断言）、`E2eProtocolTest`（Node 向量 + 高水位线语义）
