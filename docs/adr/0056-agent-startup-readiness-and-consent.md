# ADR-0056：所有 Agent 的启动准备与首次授权

日期：2026-11-01

Status: accepted（App 按需启动后端已实施；完整验收未完成）

## 问题

App 新建 / 恢复 DeepSeek 与 Codex Desktop 会话不能依赖用户事先打开后端。Host 需要区分当前已接入与可以按需启动，并以真实握手确认后端就绪。

## 决策

### 2. 各后端契约

#### 2.1 App 请求会话时按需启动后端

- `device.ready.agents` 只表示现在已经握手就绪；`launchableAgents` 表示 Host 能在会话请求时启动或接入。新建页按后者允许选择，不要求用户先在桌面设置中预启动后端。
- 用户请求新建或恢复时，Host 先复用已就绪连接；未就绪时才确保对应后端、等待原生握手，再执行会话操作。并发请求共用同一次后端准备；进程启动 / 窗口打开本身不算成功。
- DeepSeek Web 通过服务描述复用已运行服务，没有可用服务时 Host 才启动本机 DSH Web，再接入并创建会话。Codex Desktop 已接入时直接控制；否则 Host 打开 GUI 并等待 app-server 端点与握手后再创建会话。
- `orbis host --dsh` 与桌面 Host 的 DeepSeek 预启动设置只控制启动时是否提前准备，不再决定 App 是否能发起 DSH 会话。`--codex` 只控制 Codex 终端后端；Codex Desktop 按自身安装 / 接入状态独立提供。
- 未安装、配置缺失、接入失败或等待超时都通过会话失败回执说明；Host 不先把会话显示为已连接，也不自动重复创建会话。`launchableAgents` 仅在本机组件可用时包含对应类型。


## UI 关系

关联 ADR-0051 S20、X03、V12、V16–V18；沿用既有新建网格、会话失败回执和原生工具审批。可启动不等于在线，进程启动或窗口打开不提前显示连接成功。

## 验证与交付边界

- 提交前隔离复核：仅导出本次暂存内容，Host / DesktopRuntime / 后端生命周期共 74 项通过、2 项 Windows 条件未运行，lint 通过。该快照与提交前主线 `eafee84` 的独立 `npm run typecheck` 均在 `packages/pi-extension/src/index.ts:514` 报同一个 `RuntimePort.inputState` 缺失错误；完整共享工作树的较早类型检查通过不能代替本次提交快照通过。未把其他任务的 RuntimeBridge 修改并入本提交；日志见 `.artifacts/ui-regression/20261101-agent-on-demand/commit/`。

- App 按需启动专项（r30，手动编号 R32；R31 保留给最近提问提示）：Host / DesktopRuntime 61 项通过，含两类 runtime 已接入时不调用启动回调的加密链路回归；Codex Desktop / DSH Web 生命周期 13 项通过，2 项 Windows 条件用例未运行。类型检查、lint、Android 571 JVM 与 Swift Core 237 项通过。iPhone 17 全量 67 项为 55 通过 / 12 失败，其中新增 DeepSeek 用例因原生合并辅助功能标签定位错误而失败，修正测试定位后新建页整组 2 项通过，覆盖浅色、深色、XXXL 与减少动画。Android 两次设备尝试因 ADB 断开 / 崩溃未得到有效仪器结果；完整 C01–C18、375pt 窄屏及 R32 真后端仍未验收。证据与所有失败保留在 `.artifacts/ui-regression/20261101-agent-on-demand/summary.md`；未部署当前 Host 安装包。

手动 R32 见 [UI 回归方案](../testing/ui-regression.md)。DeepSeek 服务规则见 [ADR-0020](0020-deepseek-harness-shared-web-backend.md)，Codex Desktop 接入见 [ADR-0022](0022-codex-desktop-daemon-attachment.md)。
