# Orbis for iOS

原生 SwiftUI 客户端，最低支持 iOS 17，适配 iPhone 和 iPad。协议与加密使用 Apple 系统框架；P2P DataChannel 使用精确锁定的 WebRTC 140.0.0 XCFramework，由 Xcode Swift Package 管理。源码与二进制依赖保留各自许可，见 [第三方声明](../../THIRD-PARTY-NOTICES.md) 和 [WebRTC 许可](THIRD-PARTY-NOTICES/WebRTC-LICENSE.txt)。

当前界面按 Android 的新拟物主题和页面流程逐页对齐，包含：

- 配对与扫码、会话卡片主页、可搜索筛选的目录抽屉、新建会话目录浏览。
- 聊天、会话草稿持久化、Slash 菜单、历史节点预览与分支动作、权限面板和结构化交互。
- 文件浏览下载、可续传任务及附件上传；任务 / 分片格式和完整性校验已有隔离测试。
- 供应商配置与切换、连接优先级保存、基本连接状态、会话 provider 归属筛选。
- 与 Android 同源的 Agent 标识、浅色 / 深色配色、凸起 / 凹陷材质和操作反馈。
- 首页左滑会话卡片显露“关闭”，滑动达到卡片宽度的一半后触发一次触感反馈并以灰色提示“松手关闭”；长按会话进入多选，关闭在线会话保留历史，切换电脑或离开首页清空选择。
- 会话目录长按条目进入多选，点按增减选择，顶部批量归档或恢复；搜索、筛选、切换电脑或关闭目录清空选择。单选未归档会话时，顶部保留“在电脑继续会话”入口。
- 协议 v15、Keychain 身份、CryptoKit 端到端加密、Relay / LAN / P2P 三路径与 Host 选路、最近历史预览及更早历史分页。

逐页完成项、与 Android 尚有的差距和验收范围见 [UI / UX 对齐记录](docs/android-ui-parity.md)。

不涉及界面渲染的数据、协议与 Host 交互对齐范围见 [核心对齐记录](docs/android-core-parity.md)。

## 构建与运行

需要 macOS、完整 Xcode 16 或更新版本，以及已安装的 iOS Simulator SDK。打开 `ios/Orbis/Orbis.xcodeproj`，选择 `Orbis` scheme 和一个 iPhone / iPad 模拟器后运行。连接真机时，在 Signing & Capabilities 选择自己的 Development Team；必要时修改 Bundle Identifier。

在仓库根目录运行：

```sh
bash scripts/check-ios.sh
```

该脚本先执行同源 Swift 核心测试和工程检查；检测到完整 Xcode 后继续构建带本地模拟器签名的 App。这样 App 可在模拟器内访问 Keychain。GitHub Actions 的 `iOS native build` workflow 执行同一脚本。也可单独构建：

```sh
xcodebuild -project ios/Orbis/Orbis.xcodeproj \
  -scheme Orbis -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/Orbis/build/DerivedData \
  CODE_SIGN_IDENTITY=- build
```

模拟器构建使用 Xcode 的本地 ad hoc 签名，不需要 Apple Developer 帐号；安装到真机时，在 Signing & Capabilities 里选择自己的 Development Team，并按需修改 Bundle Identifier。

2026-10-27 本机验证：Xcode 27.1、iOS Simulator SDK 27.1；18 项核心与 Relay 互通测试通过（互通测试分别覆盖根路径和 `/relay/` 前缀），模拟器构建成功，并已在 iPhone 17（iOS 27.0）安装启动，检查主界面及“添加电脑”入口。带 Relay 路径修复的真机签名构建已覆盖安装到已连接设备；真机扫码和生产 Host 配对仍需单独验收。

## 核心测试

`Package.swift` 直接编译 App 的协议、Keychain、Relay 和状态源码；测试在 macOS 14 及以上运行，使用 Swift Testing（Swift 6 / Xcode 16 及以上）：

```sh
swift test --package-path ios/Orbis --disable-xctest
```

独立 Command Line Tools 如遇测试宏加载错误，使用上面的 `check-ios.sh` 自动补充插件路径。测试使用内存凭据存储，不访问用户 Keychain；固定密钥测试向量与 Node / Android 实现对齐。覆盖配对、握手、AAD/密文、跨 channel 序号、重放/篡改、分片乱序与缓冲上限、会话切换、快照回执、旧连接回调隔离及发送失败。

安装 Node.js 后，`check-ios.sh` 还会运行独立本地 WebSocket 夹具，验证真实 HTTP 配对、加密长消息双向分片、探针回声、Host 重启、Relay / LAN 回退及双 Host 并存。也可通过 `ORBIS_TEST_NODE=/absolute/path/to/node` 指定可执行文件；未找到 Node 时仅跳过这一项网络测试，CI 已配置 Node。

构建后脚本还会检查 App 的动态库依赖能否通过包内运行时路径解析，防止 WebRTC 已链接、已嵌入但普通启动仍找不到库。可对真机或模拟器产物单独运行 `python3 scripts/check-ios-bundle.py /absolute/path/to/Orbis.app`；这项检查不使用 Xcode / UI 测试器注入的动态库路径。

## 原生 P2P 互通测试

普通 Swift 核心测试不下载或链接 WebRTC，使用可控 peer 验证 ICE 回调顺序、独立握手、重放防护、优先级、超时和断线宽限。原生互通测试还会启动本地 `node-datachannel` Host，验证真实 WebRTC 传输、加密文本与二进制分片、Relay 回退，以及两台 Host 的 peer 共存；不会连接生产 Relay 或读取真实配对。

安装仓库 Node 依赖和完整 Xcode 后，可在仓库根目录运行：

```sh
xcodebuild -resolvePackageDependencies -project ios/Orbis/Orbis.xcodeproj \
  -scheme Orbis -clonedSourcePackagesDirPath /tmp/orbis-webrtc-packages
orbis_webrtc_frameworks=/tmp/orbis-webrtc-packages/artifacts/webrtc/WebRTC/WebRTC.xcframework/macos-x86_64_arm64
ORBIS_TEST_NODE="$(command -v node)" \
ORBIS_TEST_DATACHANNEL_MODULE="$(node --input-type=module -e 'console.log(import.meta.resolve("node-datachannel"))')" \
  swift test --package-path ios/Orbis --scratch-path /tmp/orbis-native-p2p-tests --disable-xctest \
  -Xswiftc -F -Xswiftc "$orbis_webrtc_frameworks" \
  -Xlinker -F -Xlinker "$orbis_webrtc_frameworks" \
  -Xlinker -rpath -Xlinker "$orbis_webrtc_frameworks" \
  --filter 'P2PTransportTests|RelayTransportTests'
```

2026-10-29 本地验证：WebRTC 140.0.0 与 node-datachannel 0.33.4 的真实回环通过，包括两台 Host 同时使用 P2P 时关闭一台不影响另一台。此项覆盖本机 host candidate；蜂窝网络、跨 NAT 打洞和真实 Host / iOS 真机仍需现场验收。

## 验收与范围

在电脑端启动 Orbis Host，打开配对窗口；手机点“添加电脑”扫描二维码。模拟器可粘贴同一个二维码的 JSON 内容。正式 Relay 使用 `wss://`；本机调试允许私有局域网 / localhost 的 `ws://`。

Relay 地址支持反向代理路径前缀，例如 `wss://example.com/relay`。配对 HTTP 请求与后续 WebSocket 连接均保留该前缀。旧测试版曾将这类地址误判为“二维码无效”；更新 App 后请在电脑端重新生成有效期内的配对二维码。

真机验收应覆盖：相机授权与退出、配对、首次安全握手、runtime/session 目录、历史预览、双向聊天、切换 runtime、停止、恢复会话、断网重连、Host 重启后的重新握手，以及前后台切换。

传输支持 Relay、LAN 和 WebRTC DataChannel P2P。Host 通过 `device.path` 决定当前路径；每条路径独立完成端到端握手并维护密钥、序号与分片重组。P2P 的请求与应答信令经过加密的 Relay；短暂 ICE 断开有 5 秒恢复窗口，协商或原生组件失败会保留其它可用路径。Orbis 只创建 DataChannel，不创建相机或麦克风轨道。会话条目与 Host 显示投影已按配对身份持久化，重新连接后先显示缓存，再核对源端状态；缓存本身不会冒充当前已应用基线。统一模型可恢复执行、模型、上下文、权限、命令、审批和队列；通知拥有独立版本与清单恢复。

多台 Host 各自保持认证连接，选择电脑只切换交互目标。系统后台通知和 TestFlight / App Store 分发尚未实现；运行仍依赖前台连接。历史已使用后台 SQLite 增量事务和有界分页，支持完整 timing、固定目标 catchup 与离线分支；下载和上传磁盘工作由独立 worker 完成，持久进度在写盘同步后发布。真实 Host / 真机联调需单独验收，不能据此认定 Android 的全部功能已对齐。

## 界面回归

`OrbisUITests` 使用独立内存夹具，不访问真实配对与 Host。对已创建的专用模拟器运行：

```sh
xcodebuild -project ios/Orbis/Orbis.xcodeproj -scheme Orbis \
  -destination 'platform=iOS Simulator,id=<专用模拟器 UUID>' \
  -derivedDataPath ios/Orbis/build/DerivedData CODE_SIGN_IDENTITY=- test
```

测试结果包保存各页面的浅色 / 深色截图。Debug 可用 `--preview-screen=pairing|home|drawer|new-session|chat|slash|history|approval|tool|downloads|status|settings|providers` 显式启动隔离预览；加 `--preview-dark` 查看深色。Release 不包含预览夹具。

供应商页支持 Claude Code 切换，以及 Claude Code / Codex 当前官方订阅的 5 小时、周剩余配额查询。详见 [功能说明](../../docs/agents/claude-providers-and-subscription-quota.md)。
