# Codex 会话权限与批准

Host 从 app-server 的 `thread/start`、`thread/resume`、`thread/fork` 响应和 `thread/settings/updated.threadSettings` 读取有效权限。App 在输入区显示权限摘要，点击进入会话权限面板，可查看及调整文件访问、网络访问、审批策略和审批处理方式，并查看授权目录及初始化错误。没有会话级数据时显示未知，不以全局配置推断。

沙箱控制访问范围，批准策略控制是否允许请求人工批准。`readOnly + never` 的受限操作不会弹批准框；`dangerFullAccess + never` 不受 Codex 沙箱限制，也不弹人工提权批准。已配对设备可通过当前会话发布的 `/sandbox`、`/network`、`/approvals` 和 `/approval-reviewer` 命令显式调整会话权限。Host 将其映射到 `thread/settings/update`，同时等待 RPC 成功和匹配的有效设置通知；相同设置直接确认已有状态（Codex 不会为无变化的设置发通知）。超时、断线和组织策略拒绝均显示未确认，不做乐观权限更新。任务或交互进行中禁止修改，设置只影响当前会话的后续任务；全局配置和电脑 trust 不属于此入口。网络切换保留原始文件策略，文件访问类型切换会明确重置额外可写目录。完全访问模式包含联网权限，不能独立禁用联网。

支持的结构化交互：

| app-server 请求 | 手机操作 |
|---|---|
| 命令批准 | 完整命令、目录、理由、额外权限；按服务端选项允许一次、会话允许、拒绝、结束本轮、保存命令/网络规则 |
| 文件修改批准 | 关联待修改文件差异、理由与请求写入范围 |
| 额外权限批准 | 查看请求的文件/网络范围，选择本轮或本会话授权，也可拒绝 |
| 用户输入 | 选择、自由文本、保密输入和多题原子提交 |
| MCP 表单 | 文本、数字、布尔和枚举字段；提交前校验类型、长度、数值及选择数量 |
| MCP 网页交互 | 展示网址、打开网页，完成后明确确认；只接受 HTTP/HTTPS |

Pi 和 Codex 共用 `InteractionWorkspace`：新请求展开独立面板，可收起、切换多条请求、查看或复制长内容；确认、选择、多选、输入和多题问答走同一套连接、超时、提交锁定及错误展示。收起和取消是独立动作，普通答案草稿在面板切换及 Android 状态恢复后保留，保密答案只留在内存，不写入 Android 的 saved state。Pi 未提供会话沙箱策略时，相同权限入口说明由电脑运行环境及扩展管理，不展示虚构的设置开关；原生本地交互仍提示在电脑端处理。未知请求用 JSON-RPC 错误响应；无法安全转换的已知请求按该接口的拒绝结构回复，并在 App 显示原因。

每次交互生成独立的手机请求 ID，原始 RPC ID 仅留在 Host 内部。响应同时校验会话、扩展和有效选项；相同回答重试不会重复提交。提交后显示等待电脑确认，收到 `serverRequest/resolved` 才确认完成；电脑端处理、turn 完成、断开及超时也会清理请求。如果本轮结束时仍未收到确认，会提示检查电脑端结果，不把未确认的提交显示为成功。设备重连和 `session.sync` 都恢复交互快照，包含已提交状态。

Windows 沙箱 readiness 只做读取。初始化失败会显示电脑端处理提示；Host 不触发 UAC、修改 ACL、安装沙箱或自动降级到完全访问。`windowsSandbox/setupCompleted` 更新故障提示。该改动不修复本机 Codex helper 对运行时缓存目录的 `CreateFileW` 故障。

协议依据为 codex-cli 0.155.1 通过 `app-server generate-json-schema --experimental` 生成的 v2 JSON Schema 和 [OpenAI app-server 文档](https://learn.chatgpt.com/codex/app-server)。升级时应一起构建 Host 和 App；在 worktree 验证通过后，按仓库的发布入口合入和发布。

验证入口：`npm run build`、`npm run check`、`npm run lint`；Android 经 `scripts/windows/android-build.ps1` 执行 `:app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest`。Compose 用例为 `CodexPermissionsInstrumentedTest`，覆盖批准详情、提交锁定、权限说明及自由文本输入。

2026-09-21 worktree 验证：Node 构建、类型检查、Lint 和 390 项测试通过；Android 252 项单元测试通过，App 与测试 APK 构建成功。Compose 设备测试尚未执行：本机可用内存不足 1GB，已有另一任务持有实例 1，未启动第二实例或安装到实际手机。

2026-09-22：增加会话权限设置和 Pi/Codex 共用交互面板。真实 app-server 已验证文件范围、审批策略和审批处理方式的更新与有效状态通知；回归入口补充 `codex-permission-settings.test.ts` 和 `InteractionWorkspaceInstrumentedTest`。

本次 Node 类型检查和 428 项测试、Android 268 项单元测试、9 项 Compose 设备测试通过。设备用例覆盖 Pi/Codex 请求切换、草稿恢复、断线禁用、重复提交锁定、电脑端完成清理、权限设置确认与失败重试。修改的 TypeScript 文件通过 ESLint；全仓库 Lint 仍被已有的 `data/wt-probe.mjs:19`（`setTimeout` 未声明）阻断。

内存紧张时，先通过构建入口完成 APK 构建并使用 `-StopDaemons` 回收编译进程，再启动所占用的模拟器。构建入口现在也为显式 AndroidTest 构建生成测试 APK 的来源及 SHA-256 manifest，可用 `android-install.ps1` 分别安装 App 和测试 APK，再用 `adb -s <serial> shell am instrument` 运行已安装的测试，避免 Gradle 与模拟器同时驻留。
