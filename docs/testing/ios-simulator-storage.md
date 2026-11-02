# 本机 iOS 共享模拟器与外接存储

2026-11-03 用户在已有 10 台固定设备的基础上授权新增 2 台 iOS，并将 iOS / Android 合计上限改为 **12 台**。当前为 5 台 iOS、7 台 Android；身份、路径和独占锁以 `~/.orbis/simulator-pool/pool.json` 为准。

| 新增设备 | 配置 | 用途 |
| --- | --- | --- |
| Orbis iOS Standard 2 | iPhone 17 / iOS 27.0 | 标准宽度回归 |
| Orbis iOS Compact 2 | iPhone SE 第三代 / iOS 27.0 | 窄屏回归 |

两台新设备仍登记在默认 CoreSimulator 设备集中，Xcode / `simctl` 按普通 UDID 识别，无须指定自定义 device set。每台默认目录中的 `data` 是指向 `/Volumes/WD1TB/iOS/CoreSimulator/Devices/<UDID>/data` 的符号链接，App 安装数据、容器和模拟器用户数据实际写入外接盘。默认目录保留少量登记文件及首次迁移前的初始数据备份；共享 iOS runtime 和原有三台 iOS 的数据位置保持原样。

## 借用要求

1. 按本机指南原子取得 `registry.lock`，再取得对应 `devices/ios-<UDID>.lock`；核实设备空闲及 owner 后使用。不能只看设备名称或 Shutdown 状态忽略租约。
2. 对登记了 `storagePath` 的设备，确认 `/Volumes/WD1TB` 已挂载，`dataPath` 是有效符号链接，解析后与 `storagePath` 相同。未挂载、链接丢失或指向不一致时停止借用并报告路径问题；不要创建本地同名目录、erase 或新建设备代替。
3. 使用显式 UDID；`xcodebuild` 继续设置 `-parallel-testing-enabled NO`，构建目录与构建租约规则照常执行。基线和候选使用同一台设备、同一配置。
4. 只清理本任务夹具。结束时停止自己的任务、关闭自己借用的设备，确认 Shutdown 后核对 owner 并释放自己的锁。设备运行时外接盘须保持挂载。

常规命令形式为 `xcrun simctl boot <UDID>`、`xcrun simctl bootstatus <UDID>`、`xcrun simctl install <UDID> <App路径>`，均在取得独占租约并确认存储路径后执行；本页没有替代租约的独立启动入口。

## 验证记录

两台新设备均完成启动、bootstatus、保存的 Orbis Debug 包安装、App 容器实际路径核对、预览首页启动、截图审阅、测试文件持久化检查和正常关闭。Xcode 自带设备列表将两台均识别为 available 的 iOS Simulator。本任务使用隔离预览，不连接真实 Host；这是设备与存储验证，不提升 App UI feature 的验收状态。

证据：`.artifacts/simulator-pool/20261103-expand-to-12/` 的 `provision-result.json`、两份 `device-*-result.json`、`xcdevice-list.json`、`app-1.png` / `app-2.png` 和 `summary.md`。Android 共用入口同步接受最多 12 台池记录，并有 12 台接受 / 13 台拒绝的边界测试。
