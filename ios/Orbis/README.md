# Orbis for iOS

原生 SwiftUI 客户端，最低支持 iOS 17，适配 iPhone 和 iPad。App 只依赖 Apple 系统框架，无第三方包。

当前界面按 Android 的新拟物主题和页面流程逐页对齐，包含：

- 配对与扫码、会话卡片主页、可搜索筛选的目录抽屉、新建会话目录浏览。
- 聊天、会话草稿和别名持久化、Slash 菜单、历史节点预览与分支动作、权限面板和结构化交互。
- 文件浏览下载、可续传任务及附件上传；任务 / 分片格式和完整性校验已有隔离测试。
- 供应商配置与切换、连接优先级保存、Host 状态与诊断分页、会话 provider 归属筛选。
- 与 Android 同源的 Agent 标识、浅色 / 深色配色、凸起 / 凹陷材质和操作反馈。
- 协议 v15、Keychain 身份、CryptoKit 端到端加密、Relay 重连、最近历史预览及更早历史分页。

逐页完成项、与 Android 尚有的差距和验收范围见 [UI / UX 对齐记录](docs/android-ui-parity.md)。

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

安装 Node.js 后，`check-ios.sh` 还会运行独立本地 WebSocket 夹具，验证真实 HTTP 配对、加密长消息双向分片、探针回声、Host 重启与正常关连接后的重连。也可通过 `ORBIS_TEST_NODE=/absolute/path/to/node` 指定可执行文件；未找到 Node 时仅跳过这一项网络测试，CI 已配置 Node。

## 验收与范围

在电脑端启动 Orbis Host，打开配对窗口；手机点“添加电脑”扫描二维码。模拟器可粘贴同一个二维码的 JSON 内容。正式 Relay 使用 `wss://`；本机调试允许私有局域网 / localhost 的 `ws://`。

Relay 地址支持反向代理路径前缀，例如 `wss://example.com/relay`。配对 HTTP 请求与后续 WebSocket 连接均保留该前缀。旧测试版曾将这类地址误判为“二维码无效”；更新 App 后请在电脑端重新生成有效期内的配对二维码。

真机验收应覆盖：相机授权与退出、配对、首次安全握手、runtime/session 目录、历史预览、双向聊天、切换 runtime、停止、恢复会话、断网重连、Host 重启后的重新握手，以及前后台切换。

当前传输仅实现 Relay 路径。LAN/P2P 实际链路、多电脑同时在线、完整条目图恢复、持久化离线会话缓存、后台通知和 TestFlight / App Store 分发尚未实现；运行依赖前台连接。附件、审批、Slash、历史分页、工具清单/详情、供应商配置与切换、Host 状态域与诊断分页已接入协议与界面。连接优先级可保存并同步给 Host，页面明确标注当前可用链路；目录按原生 provider 归属筛选。真实 Host / 真机联调仍需单独验收，不能据此认定 Android 的全部功能已对齐。

## 界面回归

`OrbisUITests` 使用独立内存夹具，不访问真实配对与 Host。对已创建的专用模拟器运行：

```sh
xcodebuild -project ios/Orbis/Orbis.xcodeproj -scheme Orbis \
  -destination 'platform=iOS Simulator,id=<专用模拟器 UUID>' \
  -derivedDataPath ios/Orbis/build/DerivedData CODE_SIGN_IDENTITY=- test
```

测试结果包保存各页面的浅色 / 深色截图。Debug 可用 `--preview-screen=pairing|home|drawer|new-session|chat|slash|history|approval|tool|downloads|status|settings|providers` 显式启动隔离预览；加 `--preview-dark` 查看深色。Release 不包含预览夹具。
