# 原生 QUIC Relay

决策与验收边界见 [ADR-0065](adr/0065-native-quic-relay-transport.md)。Host↔Relay 与手机↔Relay 两段都可独立选择 WS / QUIC。Go 适配器按 ALPN 接入同机 Node Relay 的固定 runtime / device 入口，原 E2E 协议与 LAN 优先路由保持。

旧三流使用设备 `orbis-relay-v2`、Host `orbis-relay-host-v2`，保留 ctl / msg / bulk。新五流使用明确的 `orbis-relay-v3` / `orbis-relay-host-v3`，追加独立 history / catchup，原三流索引不变。Android 使用 quic-go，Apple 使用 NWConnectionGroup；Go 下行和 Android 上行采用原生 SetPriority，Apple 上行由系统调度。两端共用 `RelaySocketConnection` 业务边界，原 Host、E2E、LAN 和文件 / 同步语义保持。历史单流 v1 只作为测试对照，服务命令入口接受 v2 / v3。

每个 Host 的 `setRelayTransportMode` 支持 ws / quic / auto 并保存偏好。候选只准备传输，失败保留现任；最新候选就绪后，旧 Relay 停止并等待本地任务退出，再认证 / 握手。QUIC 等待 Host 加密 bootstrap 后开放其他流；切到 auto 保留当前健康连接。没有新增设置页 UI。

当前未保存偏好的 Host 默认 **ws**；quic 强制模式失败明确报错，auto 只允许认证前回退。`relayTransportKind` 表示实际承载，`relaySwitchPhase` / `relaySwitchError` 独立报告切换状态。未通过完整设备、弱网 / 快网和现场门禁，不启用默认 auto，不宣称复现 Hysteria 2 的效果。

[ADR-0065](adr/0065-native-quic-relay-transport.md)记录替换边界、优势条件、预算和验收；[tickets](agents/native-quic-tickets.md)与[原功能回归矩阵](testing/native-quic-functional-regression.md)区分已跑的底层、业务、平台和未跑的设备 / 现场结果。

两段 WSS / 原生 QUIC 的有效吞吐、加压控制延迟、全部失败和复跑入口见[完整公网测试报告](testing/native-quic-public-performance-20261104.md)。Host 与参考客户端在同一 Mac，两段均连接真正公网 Relay；五轮对照观察到 QUIC 加压控制回复更可用，但未证明吞吐提速，且下载排空五轮均超时。原[单侧回环报告](testing/native-quic-performance-20261104.md)已中止，保留历史证据。公网参考端结果不代替 Q06 / Q12 的真实手机、同机 Hysteria 和受控线路验收。

后续[分层方案](testing/native-quic-layered-diagnostics.md)与[诊断报告](testing/native-quic-layered-results-20261104.md)完成 20 个原始传输窗口及 24 个双段负载窗口，控制延迟改善重复出现，吞吐仍有方向差异；定位到独立测试 socket 的内核接收丢包和 CPU quota 条件。20 秒诊断窗口全部通过不等于旧 60 秒失败已修复，默认 WS 与发布门禁保持。显式设置 `ORBIS_QUIC_DIAGNOSTICS_FILE` 仅输出按秒聚合的 QUIC / writer 元数据，缺省不记录；不是配置拥塞算法的入口。

## 构建

Go 模块固定 quic-go / gomobile 版本及校验和，推荐 Go 1.27.3：

```sh
cd native/relayquic
go test -race ./...
go build -trimpath -o orbis-relay-quic ./cmd/orbis-relay-quic
```

Android Gradle 的 `buildRelayQuic` 自动从源码生成 `app/build/generated/relayquic/relayquic.aar`，含 arm、arm64、386、amd64。构建机需 Python 3、Go、Android SDK 与 NDK `27.2.12479018`；`ORBIS_GO` 可指定 Go 可执行文件，`ANDROID_NDK_HOME` 可明确指定 NDK。不提交 AAR 或私钥。发布仍使用原有签名流程。iOS 使用 Network.framework，无第三方 QUIC 库。

本机构建 / 设备测试仍按本机 AGENTS 的内存、构建租约、共享设备入口与清理要求执行。

## 桌面 Host 配置

`config.json` 的 `relayTransport` 或优先级更高的 `ORBIS_RELAY_TRANSPORT` 支持 `ws` / `quic` / `auto`，缺省 `ws`。非法枚举明确报错。Host 通过原域名发现 `hostAlpn`，不存在时强制 QUIC 失败，auto 仅认证前回退。运行中使用 `HostService.setRelayTransportMode(mode)`；`relayTransportMode` 与 `relayTransportKind` 分别报告期望和实际值，auto / 当前承载不触发健康连接重建。

`package-host-runtime.mjs` 自动调用 `build-host-quic.mjs`，将本机架构 helper、Go 模块版本与许可证放入 `runtime/packages/host/native/`。构建需要 Go 1.27.3，`ORBIS_GO` 可指定工具链；开发态 `ORBIS_QUIC_HELPER` 可指定 helper，发行运行无需安装 Go。Windows / macOS 构建工作流已固定 Go。额外 CA 仅用于隔离测试或既有企业信任，证书 / 主机名校验不关闭。

Host helper 只接收一次性 IPC token 和远端地址，业务凭据经 ctl 流发送；按协商使用三条或五条独立回环 TCP 连接转发对应 QUIC 流。`bufferedAmount` 包含尚未完成 QUIC writer 的 IPC 帧，回执不代表对端确认。父进程退出、任一 lane 失败、取消均终止 helper 并 join；准备失败保留现任，认证失败不回退，快速改选只允许最后候选接管。

显式 `quic` 使用 3 秒 HTTPS 发现、5 秒原生准备预算；`auto` 保持 1 秒 / 1.5 秒后仅在认证前回退，认证预算均为 10 秒。该差异来自真实公网短跑对 1 秒发现超时的复现，原失败记录保留。运行中 Host API 更改当前实例期望模式；下次启动使用 `config.json` / 环境变量，API 本身不回写用户配置文件。手机每 Host 偏好仍由原手机存储入口保存。

## 服务部署示例

以下仅为部署说明；本分支开发不会自动变更线上服务。

1. 同一 Relay 域名需有客户端信任的 TLS 证书链。Go 服务直接终止 TLS；已有 HTTP 反代不会自动转发自定义 QUIC ALPN。域名若使用 CDN，须确保客户端解析地址实际支持此 UDP 服务。
2. 选择空闲 UDP 端口，例如 `24443`。若 Hysteria 已用 UDP/443，保留它并选其他端口。防火墙 / 安全组放行选定的 UDP 端口。
3. 在 Node Relay 同机运行适配器，例如：

```sh
./orbis-relay-quic \
  -listen :24443 \
  -cert /etc/orbis-quic/fullchain.pem \
  -key /etc/orbis-quic/privkey.pem \
  -upstream ws://127.0.0.1:8787/v1/device \
  -runtime-upstream ws://127.0.0.1:8787/v1/runtime \
  -max-connections 16
```

两上游必须是数字 loopback 地址的 `/v1/device` / `/v1/runtime`，客户端不能传入目标。`-runtime-upstream ""` 禁用 Host 接入。证书文件只授予服务用户必要读取权限；服务启动时加载，续期后由部署流程重启以载入新证书。非特权 UDP 端口可用普通服务用户；示例没有修改系统权限。

4. UDP / TLS 实测成功后，给 **Node Relay** 配置 `ORBIS_QUIC_PORT=24443` 和 `ORBIS_QUIC_HOST_ENABLED=1` 并按现有发布流程更新。`GET https://<原Relay域名>/<原前缀>/v1/transports` 应返回：

```json
{"version":1,"quic":{"port":24443,"alpn":"orbis-relay-v2","hostAlpn":"orbis-relay-host-v2"}}
```

未配置时返回 `quic:null`。发现端点不缓存，不接受新的域名。ws 模式跳过发现；auto 的本地 HTTP / WS 夹具跳过探测。App 的发现预算为 1 秒，QUIC 到 transport.ready 的预算为 1.5 秒；只有 auto 在准备失败后回到原 WSS，强制 quic 在无安全发现 / QUIC 不可用时明确失败。ready 后断线由原生命周期处理，不跨通道重放业务命令。

5. 回退发布时先移除 `ORBIS_QUIC_PORT`，auto 新连接会使用 WS；强制 quic 会明确失败，需要将模式改为 ws 或 auto。再按维护窗口停止适配器。已有 QUIC 连接不会仅因移除宣告而迁移，停止服务会触发它们重连。Node Relay 的普通 WS 始终保留。

## 调度与限制

Go 每流有独立 FIFO writer，原三流 SetPriority 保持 ctl `(0,false)`、msg `(3,true)`、bulk `(7,true)`。五流使用 ctl `(0,false)`、msg `(2,true)`、history `(3,true)`、catchup `(5,true)`、bulk `(7,true)`。Go → WS 仍使用现有应用汇聚 mux；WS 段和业务准入不变。所有流共享连接流控与拥塞窗口，同一 lane 内仍有队头等待，重传可能先于新 ctl。

控制 / 会话类 / bulk 队列护栏为 4 / 32 / 64 MiB、最多 16384 帧；history / catchup 与 msg 共用原 32 MiB 会话总预算，不扩大历史累计量。所有连接双向共享 128 MiB 待写预算，默认连接上限 16。取消归还预算；容量越界明确使路径失败，不静默丢密文或重放操作。在写帧、QUIC 窗口、Node 和运行时另占内存，因此总 RSS 仍须做压力验收。

Apple 同连接三流和取消已在本机及共享 iOS SE App 内验证，Android JNI 已在共享 API 35 模拟器运行通过；iOS App 内专项 2/2 还覆盖加密业务、双向切换、重握手和 LAN 保持。完整两端设备 / 人工门禁、完整 Q13 和 Q06/Q12 线路收益仍待验收。保留既有 8 KiB 分片、Host pull、durableOffset、applied ACK 和操作 unknown / unconfirmed 语义。

## 隔离验证

```sh
npm ci
npm run typecheck
node scripts/build-relay-web.mjs
cd native/relayquic
ORBIS_TEST_NODE="$(command -v node)" go test -race -count=1 ./...
go build -o ../../.artifacts/quic-fixture ./testdata/fixture
```

`ORBIS_TEST_NODE` 启用实际 Node Relay + WS Host + QUIC 手机侧认证 / 密文转发 / 重连 / 协议错误测试。fixture 使用临时身份，不读取用户状态。

Swift 核心测试可设 `ORBIS_QUIC_FIXTURE` 为上述 fixture 的**绝对路径**，同时设 `ORBIS_TEST_NODE` 为 Node 的绝对路径。`RelayQUICInteropTests` 用每次生成的临时证书验证 Apple ↔ Go QUIC；仅测试使用私有证书锚，不修改系统信任库。

Android `RelayQuicInstrumentedTest` 接受 `quicPort` 和 `quicCertificateBase64` 测试参数（fixture 的 `ready.json` 与 `cert.der`），从共享模拟器经 `10.0.2.2` 访问宿主。必须在共用入口内运行并在结束时关闭 fixture。没有 fixture 参数会标记前置条件不满足，不能记为 QUIC 已通过。

完整设备 / 人工门禁和同手机直连 WS、同机 Hysteria、原生 QUIC 的现场对照另行记录，见 [R67](testing/ui-regression.md)。本机回环成功不代表公网稳定性已改善。

iOS 设备专项使用独立 `OrbisTransport` scheme，在 App 测试宿主内导入生产 `RelaySocket`。先 `build-for-testing`，将生成的 `.xctestrun` 的 `OrbisTransportTests.EnvironmentVariables` 设置为 fixture `ready.json` 的 `ORBIS_QUIC_PORT` 和 `cert.der` 的 base64 `ORBIS_QUIC_CERTIFICATE`，还需将 `ORBIS_QUIC_BUSINESS_FIXTURES` 设置为两组隔离业务夹具的 JSON 数组（每组含 `lan`、`qr`、`port`、`certificate`），分别验证 Relay-only 与 LAN 优先；再 `test-without-building`。scheme 用 `--preview-screen=home` 隔离 App 启动，不改变配对和系统信任；没有 fixture 参数即失败。必须经共享 iOS 入口指定池内 UDID、关闭并行测试并持有 DerivedData 租约，测试后关闭 fixture 和设备。它验证实际 iOS adapter / TLS / 三流，不替代原 `Orbis` scheme 的完整 UI 回归。


## 聊天 / 后台历史隔离试验

按 ADR-0065 §10 / NQ-13，默认 `relayHistoryMode=shared`。在隔离候选 Host 中，可配置 `"relayHistoryMode": "background"` 或环境变量 `ORBIS_RELAY_HISTORY_MODE=background`：旧端未协商五流时，首屏 preview、手动 history 分页、live 和目录保留 msg，后台 catchup snapshot 走 bulk。新五流 adapter 已部署并在 Node Relay 显式设置 `ORBIS_RELAY_QUIC_HISTORY_STREAMS=1` 时，发现新增 historyAlpn/historyHostAlpn，原 v2 字段保留；App 通过 HS2 已认证能力及 HS3 接受后，手动 history / 后台 catchup 分别走独立 history / catchup，preview / live 保留 msg，文件 / 工具详情留 bulk。LAN 不协商该扩展。两段 QUIC 均可利用现有独立流；WS 继续兼容相同帧，仍有单字节流队头阻塞。LAN 保持原 msg。

配置只在新建 HostService 时读取，当前不新增设置 UI 或热切换 API。恢复 `shared` 并在授权的重启后回到原分类；不移动已封帧消息、不重放用户操作。用户 Host 尚未重启，生产未启用。NQ-13 历史结果见[聊天历史隔离报告](testing/native-quic-chat-history-results-20261104.md)。NQ-14 五流按用户要求只做[功能回归](testing/native-quic-five-stream-functional-regression.md)，不再测速，不将旧性能数字外推到五流。实际通过、既有失败与设备阻塞见[五流结果报告](testing/native-quic-five-stream-results-20261105.md)。
