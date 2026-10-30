# 轮次文件审阅验证记录

日期：2026-10-30。关联 [ADR-0052](../adr/0052-turn-file-changes-and-on-demand-diff.md)、[UI 基线 S21 / M13 / V19](../adr/0051-ui-style-motion-and-visual-stability-freeze.md)。

工作树：`/Users/wgooold/Documents/orbis-turn-file-changes`；分支 `codex/adr-turn-file-changes`；基线 `375078cbbd9d7b3299ade6b24867ec5e8b3c65f1`。本次实现尚未提交或部署，未修改运行中的用户 Host。下文 `.artifacts/` 路径均相对此工作树，仅为本机保留的证据，不纳入 Git。

## 已验证范围

Host 核心测试覆盖净变化、既有脏文件、部分采集不伪造增删、非 Git、特殊内容、固定历史、断点读取、范围隔离、持久化与过期回收。协议使用 strict schema，元数据拒绝正文及超预算页面。coordinator 与 adapter 测试覆盖真实分派前基线、受控轮次归并、缺失起点、超时释放、下一轮提前开始及 canonical 锚点。

`host-service.test.ts` 的加密集成用例通过本机真实 Host、Relay 和设备通道，使用模拟 Claude HTTP 生命周期触发文件写入。断言轮前脏内容作为基线，元数据没有 diff 正文，未请求时没有详情事件，用户读取后只得到指定文件，后续工作区再修改也不改变旧轮差异。这是协议与存储集成，未调用真实模型。

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| TypeScript 全量类型检查 | 最终代码通过 | `.artifacts/turn-file-changes/host-final-full-check.log` |
| 初次完整 Node 测试 | 148 文件，1,462 通过、12 失败、5 跳过；见下方逐项处理，不能记为全绿 | `.artifacts/turn-file-changes/host-full-check.log` |
| 最终完整 Node 测试 | 148 文件，1,468 通过、11 失败、5 跳过；失败集合与下方基线完全一致，本次新增 / 相关用例通过 | `.artifacts/turn-file-changes/host-final-full-check.log` |
| Host 最后生命周期 / 集成定向检查 | 6 文件、207 项通过；包括关闭顺序修复、Codex、Claude、loopback、coordinator 和加密集成 | `.artifacts/turn-file-changes/host-final-integration.log` |
| Host 资源 / 租约加强 | 3 文件、30 项通过；fsmonitor marker 正反对照、全局 / 设备 / viewer 并发、取消占位、租约续读和真实内容过期 | `.artifacts/turn-file-changes/core-hardening-tests.log` |
| 修改的 TypeScript ESLint | 通过 | `.artifacts/turn-file-changes/modified-typescript-lint.log` |
| Claude 插件静态校验 / testing kit | 本机 CLI 2.1.314 的 `plugin validate --strict` 通过，8 项模拟测试通过；不是模型端到端 | `.artifacts/turn-file-changes/claude-plugin-test.log` |
| iOS 状态与核心测试 | 摘要 revision 修复后 4 suites、78 项通过 | `.artifacts/turn-file-changes/ios-summary-revision-core-tests.log` |
| iOS 最终租约 / 缓存回归 | 13 项通过；同 cursor 仅重开一次、真实过期停止、3 文件 LRU / 8 MiB 硬上限、超限页不追加 | `.artifacts/turn-file-changes/ios-detail-recovery-cache-tests.log` |
| iOS Debug simulator 构建 / 包内依赖 | 通过；设备使用该构建的 fixture，后续纯模型改动未重跑 UI | `.artifacts/turn-file-changes/ios-validation.json` |
| iOS 设备 UI | 2 项通过 | `.artifacts/turn-file-changes/ios-review-ui-final2.xcresult` |
| Android JVM | 506 项通过，包括最初 11 项文件审阅测试；最终租约恢复、长目录 basename / 无后缀中间省略修复后 14 项定向测试通过 | `.artifacts/android-turn-file-changes/validation-summary.json` |
| Android Debug / AndroidTest 构建 | 通过；包对应 revision / 预览合并修复，后续模型改动以最终证据为准 | 同上 |
| Android 设备 UI | 3 项通过；测试发生在最后纯模型修复之前 | 同上记录的 device log、screenshots |

两个平台的设备测试均使用共享池中已登记设备和独占租约，没有创建新设备。iOS 为 iPhone SE（UDID `49A56E76-943A-420D-8E61-4EF31C4CFA42`），Android 为 `Orbis_UI_Polish_35` / `emulator-5554`。构建目录沿用 `ios/Orbis/build/DerivedData`、`ios/Orbis/.build`、`android/app/build`，执行前取得对应 build lease。

iOS UI 覆盖明暗、系统 XXXL 设置、强制减少动画路径、首尾边界、取消拖动、落位后请求、缓存返回及二进制状态。XXXL 沿用既有固定文字 token，不代表新增全局 Dynamic Type 支持。Android 覆盖概况零详情请求、取消拖动、落位选择、纵向阅读位置恢复、深色与 1.6 字体缩放。两端截图均已复核；这些 fixture 测试没有覆盖真实 Host 网络、真实后端或者 VoiceOver / TalkBack 全流程。

## 完整 Node 测试中的失败核对

新增关闭等待使 `HostService.stop()` 在设置 provider 发布关闭标记前出现异步让步，导致 `host-shared-model.test.ts` 的迟到 provider 发布用例失败。已把关闭标记与 generation 更新移到第一个 await 之前；该文件及相关 207 项定向测试通过。

其余 11 项已在指定基线独立归档中复现，完整失败名称集合相同。5 份测试源码与基线及当前工作树逐字节一致，未修改这些测试或相关产品实现：

| 文件 | 失败数 | 主要表现 |
| --- | ---: | --- |
| `packages/pi-extension/src/runtime-log.test.ts` | 1 | Windows 相对日志路径在 darwin 下按本机路径处理 |
| `packages/host/src/codex-shim.test.ts` | 1 | Windows 带空格路径的 shell 设置预期 |
| `packages/host/src/desktop-terminal.test.ts` | 4 | PowerShell / Windows Terminal 预期与 macOS 启动器不同 |
| `packages/host/src/sessions.test.ts` | 1 | Windows 目录路径与会话归属预期 |
| `packages/host/src/spawner.test.ts` | 4 | Windows `SESSIONNAME` / `wt.exe` 环境预期 |

基线定向结果：49 项中 38 通过、11 失败。环境为 macOS 27.2（26B123）darwin/arm64、Node 22.23.2、Vitest 4.1.11、Vite 8.2.2、TypeScript 5.9.3；复用本工作树依赖，未重新安装或编译基线。证据为 `.artifacts/turn-file-changes/host-base-selected-report.md`、`host-base-selected-comparison.json`、`host-base-selected-check.log` 及源码 SHA-256 清单。临时基线源码和夹具已在确认没有运行引用后清理，固定 Vite 缓存和验证日志保留。

## 交付与剩余边界

Android 保留包为 `.artifacts/android-turn-file-changes/packages/app-debug.apk` 和测试 APK；iOS 模拟器 App 位于固定 DerivedData。各包哈希、来源和验证范围见对应 validation JSON。现存安装包不包含最后的租约恢复 / 缓存 / Android 文件名修复，最终源码只做了相应核心 / JVM 回归；不能把这些包当作最终源码的设备验收包。早先失败 / 重试的 iOS `.xcresult` 和诊断截图继续保留；不能仅凭后来的局部成功删除尚有诊断价值的记录。

- 协议统一升级至 16，Claude bridge 升至 2；尚未安装到真实用户设备或发布 Host 包。
- DSH Web 与未协调的电脑端启动明确为 partial；没有工具执行前的忽略 / 范围外路径补录。移动文件没有可靠来源证据时为删除 + 新增。
- 快照只证明已声明工作区的时间窗净变化，无法排除所有用户 / 其他进程并发写入；不宣称所有文件都是助手修改。
- 真实 Pi / Codex terminal / Desktop / Claude / DSH 模型轮次、真实手机网络、100 文件带宽 / 时延测量、多设备并发压力和完整无障碍操作尚未验收。
- 缓存是内存缓存。Android 关闭查看器、后台或断连会释放详情，文件间切换保留阅读位置；iOS 保留当前会话内已访问的有界内容。没有实现杀进程后的离线持久 diff。

本记录区分代码实现、模拟后端集成、设备 UI fixture 和真实后端验收，不把其中一类的通过扩展到另一类。
