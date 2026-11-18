# 2026-11-18 fork 修复版

本分支基于 `WGooold/Orbis` 的 `8b087de919064db0f5419ca6e8215fc5957919be`，包含 Host 连接延迟修复、原生 Claude Code 忙时消息投递，以及 iOS 聊天和附件界面修复。

## 使用前

- iOS 的忙时发送需要同时更新 Host 和 Claude 插件；正在运行的旧 CC 会话需在任务结束后重新打开或恢复。
- 忙时消息通过原生 Mods 的 `turn.abort` 停止当前前台执行，再用 `prompt.submit(asUser: true)` 在同一会话继续。上下文保留；当前工具或请求会中断。
- 仍由原生 Claude Code TUI 执行，没有改为 Agent SDK，也不模拟键盘输入。权限模式继续读取 Claude Code 自己的设置。
- IPA 未签名，需要侧载工具为主 App、Live Activity 和通知扩展一起签名。改变签名身份或 Bundle ID 可能影响覆盖安装与推送。
- APK 使用 fork 自己的发布证书，不能直接覆盖官方证书签名的安装。发布私钥不在仓库或 Release 中。
- Android 包由同一分支构建；本批 Android 源码变更只有共享本地化更新。下面的聊天布局、相册和默认插话界面修改属于 iOS，不代表 Android 已完成相同界面改动。

## 改动

- compact 状态请求提前停止 legacy bootstrap；同一进程内保留协商结果，减少重连后重复菜单传输。
- 独立后端并行读取会话目录；Codex 的用量、运行状态等临时更新不再无条件触发目录重扫。
- Host 保留消息的 `steer` / `followUp` 意图，并按原生插件能力决定是否允许插话。
- 原生提交结果返回后才报告成功；断连导致结果未知时报告 `unconfirmed`，避免普通重发重复执行。
- iOS 忙时默认插话；重发保留投递意图，区分“发送中”和“电脑已接收，等待处理”。
- iOS 最近提问提示避让历史按钮，保留历史阅读位置；附件增加照片入口，文件选择器默认请求 App 文档目录。

## 已有验证与边界

原生 Claude Code 2.1.318 TUI 配合隔离本地受控上游，已验证普通输入框、本机已有草稿和空白 Shell 输入模式。三种情况都提交为用户消息，本机草稿保留。电脑端排队至下一次模型请求约为 104 / 133 / 700ms；这不是手机外网端到端耗时，也不是官方上游风控验证。

本批相关 TypeScript、Mods、Host 测试和 iOS 附件、等待发送、界面检查已通过。真实手机外网发送总耗时、签名后的 APNs、真机照片选择至完整上传仍需设备验收。

## 构建

在本分支提交的独立检出目录构建，输出放在源码目录之外。iOS 使用 Xcode 27.2，Release、`generic/platform=iOS`、`CODE_SIGNING_ALLOWED=NO`、`CODE_SIGNING_REQUIRED=NO`，构建号为 `2026111802`，将主 App 连同两个内嵌扩展放入 `Payload/` 后打包。

Android 使用项目已有 Gradle Wrapper 和 `:app:assembleRelease`，签名属性名及配置方式见 `android/app/build.gradle.kts`。需要 JDK 17、Android SDK 35，以及项目原生 QUIC 构建所需的 Go / NDK。凭据应放在构建环境或用户私有配置目录，不能加入提交。

Release 的 IPA 为 iOS 17+ / arm64 包；APK 的最低版本和 ABI 以最终发布说明列出的包检查结果为准。
