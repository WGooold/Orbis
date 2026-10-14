# 隔离 Host 测试台（isolated-host rig）

改动 Host / App 联动的验证**不能拿用户正在使用的那台 Host 做实验**：它跑在
`D:\orbis\.artifacts\host\OrbisHost`，同时是这台机器上 DSH Web（`127.0.0.1:3080`，也就是用户界面）
的父进程——重启它会连带终止用户正在看的会话和正在跑的 agent。

这台测试台用**独立进程 + 独立状态目录 + 本机 Relay**起一个 Host，模拟器上的 App 作为**第二台电脑**
连它；用户环境（Host、配对记录、生产 Relay、真实会话）全程不受影响。

## 组成与隔离边界

| 资源 | 隔离方式 | 备注 |
| --- | --- | --- |
| 状态目录 | `--state-dir <rig>\state` | 默认 `~/.pi-remote` 完全不碰；rig 有自己的 hostId / 配对记录 / 凭据 |
| Relay | 本机 `scripts\windows\relay.ps1`（默认 8787） | 不连生产 `wss://orbising.com/relay`；密钥落在 `data\local-relay.env` |
| LAN 端口 | `PI_REMOTE_LAN_PORT`（默认脚本用 42131） | 与用户 Host 的 42130 错开 |
| loopback | rig 自己选端口，写到 `<rig>\state\loopback.json` | 只给本机 Pi 扩展用 |
| 日志 / PID | `<rig>\logs\host.out.log`、`host.err.log`、`host.pid` | 收尾时要一起清理 |
| 模拟器 | 按 `D:\android-emulators\README.md` 的占用协议独占一台 | 用完必须关闭并释放占用 |
| App 配对 | 新增一台「电脑」，不动原有配对 | App 支持多 Host |

rig 默认落在 `<repo>\.scratch\isolated-host`（`.scratch/` 已被 gitignore，不进版本库）。

## 前置条件

1. `npm run build`（Host 从 `packages/*/dist` 运行；改了 `packages/*/src` 必须重建）。
2. 本机 Relay 已启动：
   `scripts\windows\relay.ps1 -Action Start -Port 8787`（`-Action Status` / `-Action Stop`）。
3. 模拟器与 App：占用协议见 `D:\android-emulators\README.md`；构建安装走
   `scripts\windows\android-build.ps1`、`scripts\windows\android-install.ps1`。

## 使用步骤

```powershell
# 1. 起隔离 Host（脚本会等它打出「已就绪」）
pwsh -File docs\testing\isolated-host\start-isolated-host.ps1

# 2. 配对窗口（Host 与 pair 在同一个状态目录里互斥：先 pair 后 host，或先停 host）
node packages/host/dist/cli.js pair --state-dir .scratch\isolated-host\state --print-payload
#    输出一行配对载荷（JSON），交给 App 即可，不必用摄像头扫码

# 3. 收尾
pwsh -File docs\testing\isolated-host\stop-isolated-host.ps1 -StopRelay
```

启动成功的标志（`<rig>\logs\host.out.log`）：

```
[host] LAN 端点已监听：<局域网IP>:42131
[host] loopback 监听 ws://127.0.0.1:<port>/v1/runtime
[host] relay connected
[host] hostId=<uuid> 已就绪，共 0 台已配对设备
```

### 为什么用 `--print-payload`

模拟器摄像头扫不了终端里的二维码。`pair --print-payload` 只把载荷那一行打到 stdout（诊断都在
stderr），所以脚本可以直接把它交给客户端：这是把「扫码」换成「传字符串」的唯一改动点。

### 模拟器侧的网络规则

App 只接受 `wss://<任意主机>` 和 `ws://<本机/私网主机>`（`isSupportedRelayUrl`）。模拟器访问
宿主机 loopback 用 `10.0.2.2`，属于私网地址，因此 rig 的 Relay 地址写成 `ws://10.0.2.2:8787`
即可通过校验；本机 Relay 监听 `0.0.0.0`，`10.0.2.2:8787` 能直达。

## 回归场景（App 显示投影，issue #12 验收）

| 场景 | 怎么造 | 看什么 |
| --- | --- | --- |
| 压缩后重载 | 在一个会话里触发上下文压缩（Pi/DSH 的 `/compact` 或让上下文超限），然后重开会话 | 摘要渲染在**窗口顶部**；被裁掉的旧消息不出现；窗口起点之后的内容照旧；重载后与压缩前一致 |
| 失败回合 | 让一次回合失败（模型/供应商不可用、回合中断） | 失败那一行仍然渲染，带产出方给的失败文案与 `isError`；不是空白行，也不是 App 自己拼的 |
| 自定义消息带产物 | 产生一条带 `details.remoteArtifact` 的 `custom_message` | 聊天里出现该行，并带产物卡片 |

三条都要在**重载后**再看一眼：显示行是从 SQLite 读回来的（`session_display_entries`），
重载走的是「盘上那份」而不是内存里那份。

## 取证与收尾

- 证据（截图 / logcat / 崩溃日志）按 serial + owner 存 `D:\android-emulators\evidence\<serial>\<owner>\`。
- 收尾顺序：停 App → `stop-isolated-host.ps1`（必要时 `-StopRelay`）→ `adb -s <serial> emu kill`
  → 确认 serial 从 `adb devices` 消失 → 释放设备与资源占用。
- 不要为了让下次省事而留着模拟器或 rig Host 跑：占用协议要求用完即释放。

## 现状（写这份说明时的实测结论）

已验证：

- 隔离 Host 能起来并连上本机 Relay，拿到**全新 hostId**、0 台已配对设备（`.scratch\isolated-host`）。
- `pair` 与 `host` 在**同一状态目录**内互斥：常驻 Host 活着时 `pair` 拒绝开窗（这是刻意的，
  两个进程会抢同一个 Relay runtimeId）。
- 修掉一处阻塞：`cli.ts` 的 `isLocalHostAlive()` 原来只查默认状态目录，导致**用户 Host 一在跑，
  rig 的 `pair` 就永远开不了窗**；现在按 `--state-dir` 查（不同状态目录＝不同 Relay 身份）。
- 新增 `pair --print-payload`：把配对载荷按一行 JSON 打到 stdout。

未解决（下一步）：

- 本机 Relay 拒绝签发配对码：`pair --print-payload` 走到 `Relay 拒绝签发配对码（HTTP 401）`。
  生产 Relay 上桌面 Host 走的是管理员/注册那条路，本机 Relay 还需要把对应凭据（`data\local-relay.env`
  里的 `PI_REMOTE_ADMIN_TOKEN` 或注册状态）接上，rig 才能开出配对窗口。
- 配对自动化：把载荷当 instrumentation 参数传给一个配对测试（内部走 `HostPairing`/`PairingE2e`），
  这样整条链路（起 Host → 配对 → 开会话 → 三种场景 → 截图）都不需要人操作摄像头。
