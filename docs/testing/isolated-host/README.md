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

目录里有三个脚本：`start-isolated-host.ps1`（起常驻 Host）、`pair-isolated-host.ps1`（开配对窗口）、
`stop-isolated-host.ps1`（收尾）。**pair 与 host 在同一个状态目录里互斥**：要配对先停 host。

**跑验收矩阵时加 `-ScratchSessions`**（见下节）：否则 App 的会话列表里会出现这台电脑上的**真实会话**，「打开一个会话验证断线重连」就变成拿用户正在用的会话做实验。

```powershell
# 1. 本机 Relay（脚本自己会记 pid，收尾时 -Action Stop）
pwsh -File scripts\windows\relay.ps1 -Action Start -Port 8787

# 2. 配对窗口：打印一行载荷给 App。模拟器视角的 relayUrl 用 -AdvertiseRelayUrl 改写
#    （隔离 Host 自己连 127.0.0.1，载荷里必须是模拟器能到的 10.0.2.2）
pwsh -File docs\testing\isolated-host\pair-isolated-host.ps1 -AdvertiseRelayUrl ws://10.0.2.2:8787
#    → {"v":2,"relayUrl":"ws://10.0.2.2:8787","code":"...","hostPub":"...","psk":"...", ...}

# 3. 起常驻 Host 做后续场景（配对完成后 pair 会自己退出）
pwsh -File docs\testing\isolated-host\start-isolated-host.ps1 -Dsh

# 4. 收尾
pwsh -File docs\testing\isolated-host\stop-isolated-host.ps1 -StopRelay
```

### 让模拟器上的 App 真的连上（配对测试）

`android/app/src/androidTest/.../IsolatedHostPairingInstrumentedTest.kt` 用**隔离目录**调
`RemoteViewModel.pair(...)`，跑完把临时文件与偏好删掉，因此不会碰这台模拟器上与用户电脑的既有配对。
断言是「Host 出现在 `model.hosts` 里」——这一步只有 Relay 可达、配对码有效、E2E 材料正确、
Host 真的在跑才会成立。

载荷里有引号，经 `pwsh -File` / `gradlew.bat` 传参会**被拆坏**（实测：Gradle 报「找不到任务」）。
所以测试同时接受 URL-safe base64：

```powershell
$env:ANDROID_SERIAL='emulator-5554'
$payload = (pwsh -File docs\testing\isolated-host\pair-isolated-host.ps1 -AdvertiseRelayUrl ws://10.0.2.2:8787 |
    Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -First 1).Trim()
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).Replace('+','-').Replace('/','_').TrimEnd('=')
pwsh -File scripts\windows\android-build.ps1 :app:connectedDebugAndroidTest `
  "-Pandroid.testInstrumentationRunnerArguments.class=dev.pi.remote.IsolatedHostPairingInstrumentedTest" `
  "-Pandroid.testInstrumentationRunnerArguments.pairingPayloadBase64=$encoded" --console=plain
```

启动成功的标志（`<rig>\logs\host.out.log`）：

```
[host] LAN 端点已监听：<局域网IP>:42131
[host] loopback 监听 ws://127.0.0.1:<port>/v1/runtime
[host] relay connected
[host] hostId=<uuid> 已就绪，共 0 台已配对设备
```

### 只服务合成会话（`-ScratchSessions`）

Host 的 Pi 后端默认扫 ``/.pi/agent/sessions`。测试台加 `-ScratchSessions` 时改成 `--sessions-root <rig>\sessions`，并在那里种一个合成会话（首行是会话头 `{type,id,cwd,name}`，Pi 就是靠它列目录的）：App 只会看到「隔离测试台会话」，真实会话一条都不会出现。

```powershell
pwsh -File docs\testing\isolated-host\start-isolated-host.ps1 -ScratchSessions
# 输出里会写明会话来源：仅合成会话（<rig>\sessions）还是真实会话
```

验证（不需要模拟器，实测输出：合成 1 条、真实根目录 164 条）：

```powershell
node -e "import('file:///D:/orbis/packages/host/dist/sessions.js').then(async m => { const s = await m.listPiSessions({ root: 'D:/orbis/.scratch/isolated-host/sessions' }); console.log(s.sessions.map(x => x.sessionId)); })"
```

合成会话目前只有会话头：够让 App 列出并打开它，但**还没有历史内容**。要跑「断线重连按 seq 续传」这类场景，先在 `<rig>\sessions\scratch\matrix-session.jsonl` 里追加真实形状的消息行。

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
- **配对窗口能开出来了**：配对码由 Relay 用 `Authorization: Bearer <adminToken>` 签发，所以 rig 的
  pair 进程必须带上 `data\local-relay.env` 里的 `PI_REMOTE_ADMIN_TOKEN`——少了它就是
  `Relay 拒绝签发配对码（HTTP 401）`（这是实测踩过的坑，`pair-isolated-host.ps1` 已经带上）。
- `pair-isolated-host.ps1 -AdvertiseRelayUrl ws://10.0.2.2:8787` 实测输出：
  `{"v":2,"relayUrl":"ws://10.0.2.2:8787","code":"...","hostId":"8509e449-...","hostPub":"...","psk":"...","exp":...}`
  ——隔离 Host 自己连 `127.0.0.1:8787`，交给模拟器的载荷是 `10.0.2.2:8787`。
- **配对测试实机跑通**（`IsolatedHostPairingInstrumentedTest`，emulator-5554）：`tests=1 failures=0 skipped=0`，
  同时隔离 Host 侧 `cli.js devices --state-dir <rig>\state` 列出了刚配对的设备（时间与测试运行吻合）。
  也就是说：模拟器 → 本机 Relay（`ws://10.0.2.2:8787`）→ 配对握手 → E2E → Host 发布状态，整条链路通了，
  而且没碰这台模拟器上与用户电脑的既有配对。
- 载荷里有引号，经 `pwsh -File` / `gradlew.bat` 传参会被拆坏（Gradle 会报找不到任务），
  所以走 URL-safe base64（`pairingPayloadBase64`）。

未完成：

- 三种回归场景（压缩后重载、失败回合、自定义消息带产物）还没在 rig 上跑过：它们需要 rig 上真的
  有一个 Agent 会话（Pi 扩展接进来或 `-Dsh`），上面那张表已经写清怎么造、看什么。
