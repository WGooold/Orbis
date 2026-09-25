# Orbis

**Easy Agents Everywhere.** 从手机连接电脑上的 Pi、Codex 与 DeepSeek Harness。

[官网](https://orbising.com) · [源码](https://github.com/WGooold/Orbis) · [Issues](https://github.com/WGooold/Orbis/issues) · [部署指南](docs/deployment.md) · [MIT 许可证](LICENSE)

Windows 桌面 Host 使用 **C++ / Qt / QML**，提供新拟物界面、系统托盘、按 Relay 策略激活、扫码配对、设备管理和 Agent 接入。默认要求 QQ 邮箱验证码；管理员可在 Relay 后台的「服务」页关闭该要求，允许新 Host 直接激活。构建、打包与 SMTP 配置见 [Windows Host 使用说明](packages/windows-host/README.md)。要求邮箱验证而未配置 SMTP 时，注册服务会明确提示暂未启用。

项目官网位于 <https://orbising.com/>，提供 Windows 安装版、便携版和 SHA-256 校验文件。Relay 管理后台位于 <https://orbising.com/admin/>；它使用服务器的 `PI_REMOTE_ADMIN_TOKEN` 建立 8 小时的 HttpOnly 管理会话，可查看运行状态、停用 Relay 上的 Host、撤销设备的 Relay 凭据并审计管理操作。后台看不到端到端加密的聊天或文件内容，完整解除设备信任仍在电脑 Host 中完成。

这是一个原生手机 UI 客户端，用于操作电脑上由 **Host** 托管的 coding agent（目前是 [Pi](https://github.com/earendil-works/pi-mono)、Codex 与 [DeepSeek Harness](docs/deepseek-harness.md)）。电脑上的 Host 是唯一后端和网关：它持有配对身份、设备记录、端到端加密信道、传输路径、文件服务与会话目录聚合。手机负责持久化 Session catalog、按需缓存 Session entry graph、按 runtime leaf 计算 branch 显示、跟踪消息与工具执行流、发送或追加请求、停止当前 turn，以及响应扩展发起或 agent 提出的交互。

DeepSeek Harness 默认接入官方 Web 会话，手机、浏览器和桌面 Host 观察同一个 Session，支持实时流、Steer/Follow-up、队列撤回、工具审批和历史同步；旧 ACP 适配仍保留用于兼容测试。在桌面设置启用，或使用 `node packages/host/dist/cli.js host --dsh`。安装版本、模型配置和能力边界见 [接入说明](docs/deepseek-harness.md)。

本系统不是远程桌面、终端模拟器或电脑管理工具。手机可以**请求** Host 把一个 agent 拉起来——继续一个已经存在的会话，或在手机选定的目录新建一个——但不能指定命令行、不能管理任意进程；`argv` 与 `env` 一律由 Host 构造（见下文「会话激活」）。

Remote Interaction SDK 是一等能力：第三方扩展把 confirm、select、multi-select 和 input 等交互声明为可移植状态，业务逻辑继续运行在电脑端，Android 使用原生组件渲染并返回经过 SDK 校验的结果。系统不会自动镜像任意终端自定义 UI。

## 仓库结构

- `packages/protocol`：供各 TypeScript 模块共享、经过校验且带版本的通信协议，也包括 v2 Envelope 的线契约。
- `packages/e2e`：配对身份与设备记录、配对握手、连接握手、Envelope 加密封装、配对二维码载荷。
- `packages/host`：电脑上的常驻 Host（`pair` / `host` / `devices`），含本机 loopback 端点、LAN 端点、P2P 传输、多路径聚合、进程激活与文件服务。
- `packages/relay`：提供认证 HTTP/WebSocket 的 Relay Server。它按信封的路由头转发，读不到会话内容，并且只接受身份为 `host` 的网关连接。
- `packages/runtime-bridge`：单个 Pi runtime 与 Host/Relay transport 之间经过测试的 seam。
- `packages/pi-extension`：轻量 Pi 事件/命令适配器，以及支持重连的出站 transport；它的唯一通道是本机 Host 的 loopback。
- `packages/remote-interaction-sdk`：协调 Pi 本地 UI 与手机端 `confirm`、`select`、`multi-select`、`input` 交互。
- `android`：原生 Android/Compose 客户端，包含加密身份、扫码配对、Session catalog、Session graph cache、重连、runtime view、路径显示和聊天 projection。
- `deploy`：服务器侧部署脚本与 Nginx 反代片段（TLS 由服务器现有 Nginx 终止）。

`runtimeId` 标识一个在线 runtime 连接。它不是 session ID、branch ID 或 leaf ID。Host 本身也以 runtime 身份接入 Relay（`role = "host"`），所以「电脑上在跑几个 agent 进程」和「Relay 上有几条 runtime 连接」是两件事：网关不是手机要看见的进程，进程目录由 Host 自己维护。

手机与 Host 之间流动的是**端到端加密的 Envelope**：只有路由头（帧种类、room、收发方、序号）对中继可见，会话内容是不透明密文。同一条信封可以走三条路径——LAN 直连、P2P（WebRTC DataChannel）直打、Relay 兜底；Host 选择当前生效的那条并用 `device.path` 通知手机。切换路径只换管子，密钥与业务状态都不受影响。

## 开发

需要 Node.js 22 或更高版本。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

使用 Android Studio 打开 `android/`。构建原生客户端和运行 reducer 测试需要 JDK 17 与 Android SDK 35。

## 本地运行 Relay

### macOS / Linux

```bash
export PI_REMOTE_RUNTIME_CREDENTIAL="$(openssl rand -base64 32)"
export PI_REMOTE_ADMIN_TOKEN="$(openssl rand -base64 32)"
npm ci --ignore-scripts
npm run build
node packages/relay/dist/main.js
```

### Windows PowerShell（推荐）

在仓库根目录打开 PowerShell，然后运行：

```powershell
function New-RandomSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [Convert]::ToBase64String($bytes)
}

$env:PI_REMOTE_RUNTIME_CREDENTIAL = New-RandomSecret
$env:PI_REMOTE_ADMIN_TOKEN = New-RandomSecret
$env:HOST = "0.0.0.0"
$env:PORT = "8787"
$env:PI_REMOTE_STATE_FILE = "$PWD\data\relay-state.json"

npm ci --ignore-scripts
npm run build
node packages/relay/dist/main.js
```

这些环境变量只对当前 PowerShell 窗口生效。保持该窗口打开即可持续运行 Relay，按 `Ctrl+C` 停止。

也可以使用仓库内的 Windows 脚本在后台启动和关闭 Relay。脚本会自动构建、生成本地密钥（首次运行）：

```powershell
# 在任意目录执行
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\relay.ps1 -Action Start

# 如果电脑有多个网卡，可明确指定手机要访问的局域网地址
.\scripts\windows\relay.ps1 -Action Start -RelayHost 192.168.0.103

# 关闭 Relay
.\scripts\windows\relay.ps1 -Action Stop

# 查看状态或重启
.\scripts\windows\relay.ps1 -Action Status
.\scripts\windows\relay.ps1 -Action Restart
```

> **配对二维码由 Host 打印，不由 Relay 脚本打印。** `relay.ps1 -Action Start` 只负责把中继跑起来；配对请走下文「配对新设备」的 `pi-remote pair`。实体手机和电脑需要位于同一局域网；如果 Windows 防火墙拦截了 `8787` 端口，请仅为可信的私有网络放行该端口，不要将明文 Relay 暴露到公网。

### Windows CMD

请先准备两个彼此独立的随机密钥，并替换下面的占位内容：

```bat
cd /d D:\orbis
set PI_REMOTE_RUNTIME_CREDENTIAL=替换为第一个随机密钥
set PI_REMOTE_ADMIN_TOKEN=替换为第二个随机密钥
set HOST=0.0.0.0
set PORT=8787
set PI_REMOTE_STATE_FILE=%CD%\data\relay-state.json

npm ci --ignore-scripts
npm run build
node packages\relay\dist\main.js
```

启动成功后会显示类似信息：

```text
Orbis Relay listening at ws://0.0.0.0:8787
```

Android 客户端同时支持 `wss://` 和本地/私有局域网的 `ws://`。Android 模拟器可使用 `ws://10.0.2.2:8787`；实体手机可使用电脑的局域网地址，例如 `ws://192.168.0.103:8787`。公网地址仍必须使用 `wss://`，不要把明文 `8787` 端口直接暴露到公网。

公网部署方式：Relay 容器只把 `8787` 绑定到 `127.0.0.1`，公网 TLS 由服务器现有 Nginx 终止——在现有 TLS `server` 块中包含 `deploy/nginx-relay-location.conf`。该配置使用 `/relay/` 前缀并在转发前移除前缀，因此客户端 Relay 地址应填写：

```text
wss://example.com/relay
```

Relay 仍会收到它所要求的 `/v1/device`、`/v1/runtime`、`/v1/pairings` 和 `/healthz` 路径。不要把 `8787` 直接绑定到公网网卡。

### 构建与部署

正式 Relay 发布只通过 [Relay deploy](.github/workflows/relay-deploy.yml) 工作流；服务器初始化、Secrets、HTTPS、STUN、状态备份和回滚见 [部署指南](docs/deployment.md)。Windows 安装包由 [Windows Host build](.github/workflows/windows-host-build.yml) 工作流构建和验证。

Android 使用 Windows 工具链及 `scripts/windows/android-build.ps1 testDebugUnitTest assembleDebug`，不要绕过构建锁。配置 JDK / SDK 和设备安装方法见 [Android README](android/README.md)。

`packages/*/src` 是实现源，`dist` 只由 `npm run build` 生成。修改源码后先构建，再重启 Host 或 Agent；Pi 的 `/reload` 不会更新已加载的扩展模块。

## 配对新设备

配对在电脑上进行，手机只负责扫码。正常情况下只做一次：换手机、重装 APP 都是再扫一次的事。

### 1. 准备 Host 配置

Host 需要 Relay 地址与 runtime 凭据，它复用 `~/.pi/agent/remote-control.json`（也可以用环境变量 `PI_REMOTE_RELAY_URL` / `PI_REMOTE_RUNTIME_CREDENTIAL` 覆盖）：

```json
{
  "enabled": true,
  "relayUrl": "wss://relay.example.com",
  "runtimeCredential": "与 PI_REMOTE_RUNTIME_CREDENTIAL 相同的值"
}
```

### 2. 打开配对窗口

**先确认常驻 Host 没有在跑**——两个进程在 Relay 上共用同一个 `runtimeId`，会互踢下线，配对消息大概率落到对方手里。然后：

```bash
node packages/host/dist/cli.js pair
```

终端会打印二维码并打开 **120 秒**的配对窗口。

### 3. 手机扫码

用 APP 的「扫码配对」扫这张二维码即完成配对，不需要再输入任何密钥或配对码。

二维码由 **Host** 生成，里面带着 Host 公钥、一次性配对密钥、Relay 地址与一次性码，以及（可选）局域网地址。**Host 公钥只经「屏幕 → 摄像头」这条物理路径到达手机，它是整条信任链的根**：之后无论走哪条路径，手机只认这个公钥。一次性配对密钥在配对窗口内有效、不落盘、用完即弃。

### 4. 起常驻 Host

```bash
node packages/host/dist/cli.js host           # 只启用 Pi 后端
node packages/host/dist/cli.js host --codex   # 同时启用 Codex 后端（需已全局安装 codex-cli）
```

Windows 上可以双击 `scripts\windows\start-host.cmd`，它会在一个独立的最小化窗口里拉起 Host（关掉那个窗口即 Host 停止）。日志写在 `data\host-pair.log` 与 `data\host-pair.err.log`。

Host 就绪后会打印 `hostId`、已配对设备数、LAN 直连地址；有 Pi 进程经本机通道接入时也会一并打印。

### 管理已配对设备

```bash
node packages/host/dist/cli.js devices              # 列出已配对设备
node packages/host/dist/cli.js devices revoke <id>  # 撤销一台
```

撤销是**设备级**的：每台设备有自己独立的 `pskRoot`，撤销一台不影响其他设备，也不必给其他设备重新配对。撤销后重启 Host 才会丢掉那条通道。APP 里的「取消配对」是设备侧主动解除。

Host 的状态放在 `~/.pi-remote/`：`host.json`（身份私钥）、`devices.json`（设备记录，0600）、`loopback.json`（给本机 Pi 扩展看的发现文件）、`config.json`（可选的 `adminToken` / `lanPort` / `stunServers`；`adminToken` 只在配对时用来向 Relay 换取管道凭据）。它与 `~/.pi/agent/remote-control.json` 是两处不同的配置。
## 启用 Pi 扩展

远程控制默认关闭。必须在用户级配置文件 `~/.pi/agent/remote-control.json` 中显式启用：

```json
{
  "enabled": true,
  "relayUrl": "wss://relay.example.com",
  "runtimeCredential": "与 PI_REMOTE_RUNTIME_CREDENTIAL 相同的值"
}
```

扩展的**唯一通道是本机 Host 的 loopback 端点**：它在 `session_start` 读 `~/.pi-remote/loopback.json` 发现 Host 并接上去；**Host 没起来就等它**（每次重连前重读发现文件），不回落到 Relay。中继已不再接受 agent runtime 的连接（`role` 必须是 `host`），而那条回落路本来也只能把明文会话内容播给手机，与「中继零知识」的前提直接冲突。

因此顺序是「先起 Host，再起 Pi」。Pi 先起也没关系——它会一直等 Host，Host 起来后自己接上；若仍未接上，在 Pi 里执行一次 `/reload` 即可。

`~/.pi-remote/loopback.json` 里的 token 是**防手滑**，不是安全边界：本机任何进程本来就读得到这个文件。它防的是「残留文件指向一个已退出的 Host」和「一台机器上跑着两个 Host 时接到了错的那个」——两者都表现为「连上了但没有会话」，比连不上更难查。

扩展会随 Runtime metadata 上报 Pi 所在机器的 `hostname`，APP 据此区分不同设备上的 agent 进程并在侧边栏按“主机 → 目录 → 会话”树状分组，不需要额外配置。

> 已知遗留：`relayUrl` 与 `runtimeCredential` 现在由 **Host** 使用，扩展本身已经用不到它们，但配置校验仍然要求这两个字段存在。收掉这块死配置要动配对时的配置交接，留作后续。

在本仓库中开发时，Pi extension 由 **Host 按需拉起**：`packages/pi-extension/package.json` 的 manifest 指向 `./dist/index.js`，扩展对本仓库 workspace 依赖使用普通 package import（解析到各包的 `dist`）。因此改完扩展或其本地依赖后的生效方式是：

```bash
npm run build        # tsc -b，刷新各包 dist
```

然后让 Host 重新拉起一个 Pi 进程（手机端对会话执行 activate，或重启 Host）。早期的 source-first 热重载方案（manifest 指向 `src/index.ts`、依赖走 `@pi-remote/*/source`、靠 Pi 的 `/reload` 热更新）已移除——`/reload` 不再是扩展代码的更新手段。设计动机存档见 `docs/adr/0004-pi-extension-source-first-development.md`。

扩展只会在 `session_start` 时连上本机 Host，并在 `session_shutdown` 时断开。连接后 Pi 发布轻量 Session catalog 和每个 Runtime 的当前 Session view；用户打开在线 Runtime 时，Android 才发送带 `sessionId`、graph version、entry digest、leaf、branch fingerprint 和 `syncId` 的 graph 同步请求。侧边栏中的缓存历史入口只读取已有本地缓存。可安全验证时响应只包含缺失 entry，否则发送完整 graph replace。Android 根据 graph 和 runtime leaf 自己计算 Pi-equivalent display projection；扩展不会直接读取 session JSONL 文件。

也可以只用环境变量显式启用。扩展入口用构建产物 `dist/index.js`（与 manifest 注册的同一份；manifest 已自动加载扩展，通常不需要 `-e`，仅当 Pi 配置里没有本包时才显式指定）：

```bash
PI_REMOTE_ENABLED=true \
PI_REMOTE_RELAY_URL=wss://relay.example.com \
PI_REMOTE_RUNTIME_CREDENTIAL=... \
pi -e ./packages/pi-extension/dist/index.js
```

在 Pi 中执行 `/remote-status`，可以查看当前 runtime 是否已启用远程控制。

扩展加载、Session 启动/关闭、Host 通道命令链路以及 `/reload` 会写入仓库 `data/pi-extension-runtime.log`，每行是一条 JSONL 记录。日志分为 `error`、`warn`、`info`、`debug` 四级，默认使用 `info`：保留生命周期和 reload 主链路，详细的低频诊断记录可通过 `PI_REMOTE_RUNTIME_LOG_LEVEL=debug` 打开；设置为 `error` 只保留失败记录，设置为 `off` 完全关闭文件日志。其中 `extension_loaded` 可用于确认 Pi 实际加载的入口文件，`extension_reloaded` 表示 `session_start` 收到了 `reload` 原因。需要修改日志位置时可设置 `PI_REMOTE_RUNTIME_LOG`，相对路径以 Pi 工作目录为基准。日志采用异步追加、按批次写入，并限制待写队列最多 1024 条；日志失败或队列溢出都不会阻塞或影响 Pi。Android 端对应的发送、接收和连接变化会使用 `PiRemote.ReloadTrace` 标签写入 Logcat，可用 `adb logcat -s PiRemote.ReloadTrace:I` 查看。

## Pi 斜杠命令菜单

Android 输入框保留普通聊天消息；命令则只有一个入口：输入 `/` 打开当前 runtime 发布的菜单，选择命令后执行。App 不维护命令白名单，也不会把任意 `/...` 文本当成普通消息发送；未从当前菜单选择的 Slash 输入不能提交。

APP 顶层以在线 Runtime 列表为入口；一个 Runtime 对应一个在线 agent 交互窗口（一个 Pi 进程，或 Codex 的一个活跃 thread），点击后直接显示该 Runtime 当前 Session 和 branch。Session Catalog 只按 Session ID 合并存储元数据，不记录 Runtime 归属或在线状态；另保留最近一次写入缓存的 `hostname`，仅用于侧边栏按“主机 → 目录 → 会话”树状分组。在线 Runtime 列表页左侧的“缓存的历史记录”侧边栏按该树状结构列出所有已缓存 Session：有在线 Runtime 的点击进入该 Runtime，没有在线 Runtime 的以只读缓存历史显示。APP 手动别名、Pi Session display 名称和主机名仍分别用于本地显示、Session 标题和运行实例区分。

菜单由电脑端 Pi runtime 动态生成并合并以下来源：

- 可远程执行的 Pi 内置命令：`/model`、`/tree`、`/thinking`、`/name`、`/session`、`/copy`、`/fork`、`/clone`、`/new`、`/compact`、`/resume`、`/reload` 和 `/quit`；
- 当前加载的 Skill；
- 当前加载的 Prompt Template；
- 扩展通过 `pi.registerCommand(...)` 注册的命令。

需要选择值的内置命令会同时发布当前 runtime 的候选项，例如已经配置认证的模型、Session、tree 节点和可 fork 的用户消息。Session 替换、reload、模型变化或 agent 完成一轮工作后，runtime 会重新发布菜单快照。

`/tree` 在 APP 里有自己的整页（聊天页顶栏「历史与分支」入口与它同一个页面）：树占据主要屏幕空间，搜索是独立输入框。页面按轮次组织对话，主线上的节点连续排列、只有分叉处才加深缩进；默认只展开当前分支，其他分支折成一行摘要（如「尝试另一种实现 · 8 轮对话」），点一下才展开。工具调用与设置项收在每轮的「N 项工具与设置」里，默认收起；筛选保留默认、无工具、仅用户、书签、全部五档，书签仍由 Pi 端新增/编辑。

点节点只**预览**附近的对话（面板上标着「正在预览 · 不会改变电脑端会话」），底部再给出唯一的正式动作，节点 ID 不再写进聊天输入框：

| 选中的节点 | 动作 | 电脑端发生什么 |
|---|---|---|
| 用户消息 | 编辑这条消息并重新开始 | 分支移到这条消息的父节点，原文回到手机输入框；改完重发就是一条新分支 |
| 助手回复 | 从这条回复后继续 | 分支停在这条回复之后，接着往下聊 |

两种动作都只是 `slash.execute { name: "tree", args: <entryId> }`：Pi 的 `navigateTree` 落到用户消息时会把 leaf 移到父节点并回传 `editorText`，落到其他节点时直接把 leaf 移到该节点。APP 不自己读写 Session JSONL 来模拟分支。

Codex 后端发布的也是同一个 `/tree`，交互一致，语义对齐 codex 官方 TUI 里「回到过去某条消息」那一套——**原地改写当前会话**，不派生新会话：

- 选项来自当前 thread 的条目图，同样是带 `parentId` 的预序扁平链，所以整页树、预览、筛选、搜索全部复用；工具调用与结果用 `role: "toolResult"` 归到「工具」，默认收进细节；
- 两个动作都落到 `thread/revert` 的 `beforeTurnId`：用户消息 = 那条消息所在的轮（丢掉这一轮及其之后）并把原文交回输入框；助手回复 = 那条回复所在轮的**下一轮**（历史恰好留在该回复上）。选中的本来就是最后一条时无事可做，直接回成功；
- 这是**原地截断**：该点之后的对话会被永久丢弃。app-server 的 `thread/rollback`（只丢尾部若干轮）对 paginated thread 已不可用，`thread/fork` 虽能保住原线却每跳一次就多一条会话，都不符合「编辑过去消息」的预期，所以没有采用；
- 截断后 Host 用 `thread/turns/list`（`itemsView: "full"`）重新拉一遍历史再广播，手机随后主动拉一次快照——后端广播的快照用的是自造 syncId，手机不采。

会话树要求协议版本 7：Relay、Host、Pi 扩展和 APK 需要同步更新。电脑端执行 `npm run build` 后重启 Host 与 Pi 会话，扩展代码不能靠 `/reload` 更新；旧版本连接会收到升级提示。

Android 只发送统一的 `slash.execute { name, args }` 调用。Skill、Prompt Template 和扩展命令由 Pi 自己的 prompt/command expansion 分发；内置命令通过 Pi 提供的真实 `ExtensionCommandContext` 执行，所以 Session、tree、fork、compact 和 reload 仍使用 Pi 的正式 API，远程层不会读写 Session JSONL 来模拟命令。扩展处理器和 Pi 工具始终在电脑端运行。

`/settings`、`/scoped-models`、`/export`、`/import`、`/share`、`/changelog`、`/hotkeys`、`/trust`、`/login` 和 `/logout` 依赖 Pi TUI 自身的本地组件或凭据/信任配置 API；Pi 0.84.4 没有向扩展暴露可等价远程执行的 command context，因此当前不会发布到 Android 菜单。它们也不会被错误地作为模型消息发送。停止当前 agent turn 仍是聊天页右上角的运行控制，不属于 Slash 命令。

Codex 后端走同一条 `slash.execute` 车道：它在自己的适配层把命令映射到 app-server 的 JSON-RPC 调用，并且**只发布它能兑现的那个子集**。APP 不按 `agentKind` 分支渲染，菜单里出现什么就来自 runtime 发布的能力声明——某个 backend 没声明的命令就是不出现，而不是点了才报错。

## 会话激活（Host 拉起 agent）

手机可以请求 Host 把一个 agent 拉起来。这是**有边界的**放开：手机能选目录，不能指定命令。

两个档位：

| 档位 | 语义 | 手机传什么 |
|---|---|---|
| L1 继续已有会话 | 点开一个已存在但没在跑的会话，Host 按会话记录里的 `cwd` 拉起并 resume | 只有 `sessionId` |
| L2 在指定目录新建 | 手机浏览电脑目录、挑一个，在那里起一个全新会话 | `{ agentKind, cwd }` |

差别只在于 `cwd` 从哪来：L1 来自会话记录（两个 backend 的会话记录里都带 `cwd`，所以 L1 不需要向手机要任何参数），L2 由手机选择。会话记录里的 `cwd` 已经不存在时，激活直接失败并回报，**不会静默换一个目录**。

L3「手机直接给命令行」**永久排除**：Host 只为受支持的 agent backend 构造启动参数，`argv` 与 `env` 全部由 Host 构造，spawn 一律走 argv 数组、禁止 shell。手机侧也根本没有输入 `argv` / `env` 的入口。

**拉起方式**

- **Pi**：一个会话对应一个 Pi 进程。L1 用 `pi -e <扩展路径> --session <会话文件>`，L2 用 `pi -e <扩展路径> --session-id <新 uuid>`；追加 `--mode rpc` 即为无头。
- **Codex**：不按会话起进程。Host 管一个常驻的 `codex app-server` daemon，L1 / L2 都只是 daemon 里的一次调用（resume thread / 新建 thread），新建时把手机选的 `cwd` 传进去。

被拉起的进程通过 loopback 自己注册回 Host，Host 只跟踪 pid 用于并发上限、外加一条「同一会话不重复拉起」的去重，不需要 pty。

**有头还是无头**

`session.activate` 可以带 `spawnMode`，缺省 `auto`：有可交互桌面会话就开一个可见窗口（Windows 上用 `wt.exe`），没有（SSH、服务身份、无窗口站）就降级为无头，并在回执里**如实说 headless**，手机侧标注「此会话无头」。请求了有头但本机开不出窗口时，Host 降级并如实回报——绝不假装开过窗。

默认偏好有头不是出于好看：无头进程里扩展发起的本地 UI 交互没有任何回答者（手机答不了，电脑上又没窗口），turn 会永久挂住。

**所有权**

被 Host 拉起或新建的进程归 Host 管理，但不提供「杀掉任意进程」，也不自动重启：你在电脑上手动关掉的进程只标记离线；Host 重启不会自动拉起任何进程，你点开会话时才会重新激活。

**目录浏览**

手机侧的「新建」走一次**只读**的目录列举：从盘符/根开始逐层下钻，不设浏览起点、不设白名单，和文件管理器一样。有过会话的目录会被标出来，便于排在前面。
## 任意电脑文件下载

已配对手机可以提交电脑文件路径，下载该台电脑上任意普通文件。**下载由电脑上的 Host 服务，和任何 Pi 进程是否在运行无关**：手机发来的 `file.download` / `artifact.download` 命令寻址到 Host，Host 就地读盘、分片发送；Host 服务不了（找不到文件、并发已满）时如实回报失败，不会转交给某个 runtime。

Android 只有一个下载页面——一个路径输入框、一个下载按钮、一个下载列表。主页面的下载入口和聊天页右上角的下载按钮打开的是**同一个页面**；聊天消息中识别到的 Windows/Unix 文件路径也可点击，点击的含义就是「请电脑把这个文件发过来」。页面持久化显示排队、下载中、暂停、失败和完成任务。下载不按路径、扩展名、MIME 类型或文件大小设置产品限制，传输使用固定大小分片并校验偏移与最终总长度，下载器将任务元数据和本地 `.part` 文件持久化；连接中断或 App 重启后可从已接收 offset 继续。

Android 10 及以上保存到系统“下载”目录，较低版本保存到 Orbis 的应用下载目录，下载器会显示最终保存位置。实际可下载大小仍受电脑和手机存储空间、文件系统与网络条件约束。

> 扩展注册 artifact（`registerRemoteArtifact` / `createRemoteArtifactMessage`）仍然可用，用于在聊天里生成可点击的下载卡片；但下载请求的目标始终是 Host，扩展不参与分片传输。

**手机上传文件到电脑**

聊天输入框可以把手机上的文件传到电脑。上传与发消息是**两步**：先上传落地，消息只携带**已经完成**的附件路径。

落地位置是会话 `cwd` 下的 `.pi-remote-uploads/`（目录由手机给出，Host 只校验「绝对路径 + 可创建」）。附件对 agent 而言就是**路径**：`user_message.attachments` 是绝对路径数组，桥接层在发送前把 `附件：<path>` 拼进正文，由 agent 自己的工具去读——不做描述符、不做图片嗅探、不走 content parts。附件是无条件支持的，没有能力位。

驱动权在发送方、信用在接收方：手机按 Host 回报的**已落盘前缀**推进，它同时是断线后的续传基准；Host 自己算一遍 sha256、校验通过后才改名落地。续传的身份是内容而不是 `uploadId`——`sha256(runtimeId, directory, fileName, size, sha256)` 决定 `.part` 文件名，所以手机重试、Host 重启都会命中同一个 `.part`。

> 分片在 E2E 信封里是 base64，线上体积约为原文件的 4/3（100 MB 走 133 MB）。这是刻意接受的代价：给设备方向加二进制通道会把数据面和控制面绑死。详见 `docs/adr/0006-phone-file-upload.md`。

**主动推送（电脑 → 手机）已删除。** 它曾让 Pi 进程把构建产物直接推给某台已配对设备（`runtime.push.*` / `artifact.push.*`，字节由中继托管）。删掉它的原因有两个：那条链路从未接通（Host 的 loopback 端点在收到 `runtime.push.*` 时直接忽略，缺的是 Host 转发那一段），而且它要求中继持有并发送用户的文件、还要收设备发来的**明文**进度回执——与「中继只路由、不解内容」的边界相冲突（见 `docs/adr/0009-remove-computer-to-phone-push.md`）。

需要把文件送到手机，就用上面的「手机请求型下载」：电脑上的文件由 Host 就地读盘发送，发起方是手机。Android CI 因此只构建 APK，安装走 `adb install`。

## Remote Interaction SDK

第三方扩展不应了解 Relay 凭据或底层协议。它们通过 SDK 发起结构化交互，同时保留 Pi 原有的本地 UI 作为后备：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiRemoteInteraction } from "@pi-remote/interaction-sdk";

export default function (pi: ExtensionAPI) {
  const remote = createPiRemoteInteraction(pi, "my-extension");

  pi.on("tool_call", async (event, ctx) => {
    const approved = await remote.confirm(ctx, {
      title: "是否执行受保护操作？",
      description: "该操作可能修改当前项目",
      toolName: event.toolName,
      argumentSummary: JSON.stringify(event.input),
      confirmLabel: "允许执行",
      cancelLabel: "拒绝",
      timeoutMs: 60_000,
    });
    if (!approved) return { block: true, reason: "用户拒绝了该操作" };
  });
}
```

SDK 会把每个请求绑定到 runtime、扩展和唯一请求 ID。本地端与手机端可以同时响应，但只有第一个有效响应会生效。未知请求、重复响应、runtime 不匹配、扩展不匹配、响应类型不匹配和无效选项都会被拒绝。Abort、超时、断线和取消都有明确结果。SDK 不会尝试镜像任意 `ctx.ui.custom()` 组件。

## 安全属性

- 远程控制默认关闭，只有用户级显式配置才能启用。
- 配对必须在电脑上显式开窗（120 秒、一次性），二维码里携带 Host 公钥；该公钥只经「屏幕 → 摄像头」这条物理路径到达手机，它是整条信任链的根。
- 手机与 Host 之间端到端加密：中继只能读到路由头（帧种类、room、收发方、序号），读不到会话内容，也无法把合法密文改投给别的设备。
- 中继只接受身份为 `host` 的网关连接，不持有任何 agent runtime 连接，也不转发运行时的明文事件。
- 公网 Relay 地址必须使用 TLS（`wss://`）；可信本地网络可以显式使用受限的 `ws://`。
- 每台设备有独立 `pskRoot`；撤销是设备级的，不影响其他设备，也不必给其他设备重新配对。
- Host 侧只持久化身份私钥与设备记录（`~/.pi-remote/`，0600）；Android 用系统加密存储保存自己的身份材料。
- Relay 始终根据已认证连接和信封路由头转发；客户端声明的 session ID 不能用于选择 runtime。
- 手机能下达的指令止于「把 agent 拉起来」：可以传 `sessionId` 或 `{ agentKind, cwd }`，不能传命令行或环境变量，Host 只构造受支持 backend 的启动参数（见「会话激活」）。
- 已配对设备视为可信，所以不做 cwd 白名单、不做桌面二次确认、不做速率限制——安全由配对与端到端加密提供，不靠校验设备输入。
- 不提供强制终止/重启/自动恢复进程、包管理、凭据/provider/trust 写入；菜单中的 `/quit` 只请求当前 agent 自行优雅退出。
- 无法接管的本地扩展 UI 会 fail closed，并显示「需要在电脑处理」；系统不会伪造响应。
- Slash 菜单由已认证的 runtime 发布，各 backend 只发布自己能兑现的子集；Android 不维护命令 allowlist，自由输入的 `/...` 不会进入普通消息通道。
- 文件下载接受手机提交的任意电脑路径，也兼容已注册的 artifact ID；请求一律由 Host 服务，不按路径、类型或大小实施 capability 限制。
- 手机请求型下载只保存在 Android 的 `.part` 文件中，中继不持久化任何传输状态。
- 设备凭据等价于「发消息 + 调用该 runtime 发布的 Slash 命令 + 按路径读写 Host 账户可读写的文件」，而不是只读凭据。需要整机隔离时，使用受限 Windows 用户、容器或虚拟机。
- 中继只在内存中转发实时内容，不持久化聊天记录、session 数据或文件字节；它落盘的只有设备凭据与配对状态。

完整产品要求和测试决策见 `PI_REMOTE_CONTROL_SPEC.md`。

## 参与与许可证

后续开发、问题讨论和发布统一在 [WGooold/Orbis](https://github.com/WGooold/Orbis) 进行。开始前请读 [CONTRIBUTING.md](CONTRIBUTING.md)、[领域词汇](CONTEXT.md) 和相关 [ADRs](docs/adr/)。

项目原创代码采用 [MIT](LICENSE)。第三方代码、Qt 动态库和品牌图标依赖保留各自的许可与声明，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。现有 `@pi-remote/*` 包名和 `dev.pi.remote` Android 应用 ID 为兼容已有安装而保留。
