# Claude Code 供应商与官方订阅配额

2026-10-30。参考仓库拉取在 `../cc-switch`，固定版本 `4ed071500b07ba5801be84c96ddb4e03bdf48a2d`。配置字段归属参考 `src-tauri/src/live/floor.rs` 和 `live/project/claude.rs`；配额接口与凭据格式参考 `services/subscription.rs`。

## 使用入口

- Host：Agent → Claude Code → 供应商配置。可以导入当前配置、添加预设或自定义配置、编辑、复制、排序和启用；官方预设使用 CLI 中已登录的 Claude 账号。原生 Anthropic Messages 预设共 126 个，不包含需要 CC Switch 代理转换或专属 OAuth 的预设。
- iOS / Android：连接状态页直接按 Agent 显示当前供应商，所有行共用一张大卡片，行内透明、无独立白底。点击透明的“切换”图标文字入口，通过 App 共用菜单打开该 Agent 的供应商列表；点击官方卡片正文刷新订阅配额；图标有读数后专门翻面查看周期，菜单点击独立处理。设置页只保留连接优先级。
- Claude Code / Codex 当前启用的官方配置在 Host 提供“查询订阅配额”弹窗，含剩余百分比与重置 / 查询时间。App 将 44pt/dp 细线环围在 Claude / Codex 图标外，周期（5h / 周）及百分比放在角标，操作区域为 64×56pt/dp。首次无读数时图标也可查询；有数据后图标通过左倾 24° 斜轴三维硬币翻面切换周期；图标外围有薄边与随角度变化的扫光，翻转额外轻倾 4°、抬起 2pt/dp、放大 3.5%，角标原位淡化，卡片正文继续负责刷新。首次成功获得两个窗口读数后自动演示 5h → 周 → 5h，两次翻面各 560ms（220ms 翻出、340ms 缓入），中间停留 900ms；用户点击立即接管，后续刷新保留所选周期。刷新图标轻摆、按压反馈和查询旋转引导操作，无可见点击说明。数据返回后圆弧用 700ms 过渡至实际比例，刷新或失败保留上次读数；减少 / 关闭动画时跳过演示，直接切换。API Key 登录没有订阅配额，会提示登录官方订阅账号。
- Claude Code 切换影响重新打开的会话；运行中的任务或待确认权限会阻止切换。项目级配置、终端启动参数和独立终端环境变量仍遵循 Claude Code 自身的优先级。

## 配置与凭据

Host 使用现有 `providers.json` 目录和事务日志管理 Claude 的 `settings.json`，尊重 `CLAUDE_CONFIG_DIR`。切走前回填供应商字段；切换时替换路由、认证、模型映射和供应商自有字段，保留 Hooks、权限、插件、MCP 与其他共享设置。写入失败或重载失败回滚；检测到外部修改时拒绝覆盖。OAuth 凭据文件与系统钥匙串不参与供应商切换。

配额查询复用 Host 进程内的供应商锁，并合并同一配置的并发查询。请求只包含 Agent、已保存的供应商 ID 和请求 ID；手机不能提供 URL、配置或凭据。服务端重新核对当前配置，分类标签不能伪装官方供应商。

Claude 使用当前目录的 `.credentials.json` 或 macOS 钥匙串，也支持原生配置中的 `CLAUDE_CODE_OAUTH_TOKEN`。Codex 使用当前 `auth.json`；macOS 支持按 `CODEX_HOME` 区分的 `Codex Auth` 钥匙串条目。Host 托管的 Codex 账号启用后同样查询 CLI 当前登录，查询操作不会在后台轮换 CLI 的刷新令牌。非 macOS 的显式 keyring 存储会提示改用 CLI 文件登录存储，默认文件登录可直接查询。过期或被拒绝的登录会提示到 CLI 重新登录。

固定查询端点分别为 `https://api.anthropic.com/api/oauth/usage` 与 `https://chatgpt.com/backend-api/wham/usage`，禁止重定向，限制响应大小与查询时间。手机仅收到两个标准化窗口的有限数字和时间，错误消息不携带凭据、URL 或原始响应正文。

Codex 按窗口实际时长识别 5 小时 / 7 天，不按 primary / secondary 的位置猜测。缺失、未知时长、无效数字显示“暂不可用”；Codex 用量为 0 时不展示可能是占位值的重置时间。手机在断线、切换电脑或供应商后丢弃对应旧查询；两个 Agent 的读数分别保存，失败保留上次读数和错误，可再次查询。

## 本地验证

新增回归覆盖 Claude 配置回填、共享字段保留、原子回滚、外部编辑冲突、官方配置识别、模型映射、配额窗口与缺失值、固定端点、错误脱敏、查询合并及与切换串行化。加密链路测试覆盖 Claude 切换和配额响应；iOS / Android 状态测试覆盖响应关联和跨电脑隔离。

验证使用隔离目录、测试登录数据和模拟配额响应；未调用个人账号的真实订阅接口。接口的服务端可用性和真实套餐响应需要使用已登录账号验收。

本轮验证：TypeScript 类型检查、Host / Protocol 源码 lint、92 项相关后端回归、193 项 Swift 测试、499 项 Android 单元测试和 4 项 Host CTest 通过；iOS 模拟器 App、Android Debug APK 和 macOS Qt Host 构建通过。全量 Vitest 为 1448 通过、5 跳过、11 失败；11 个失败在独立的原始 HEAD 副本中全部复现，涉及既有 Windows 路径/终端假设和目录会话测试。全仓 lint 另受已有 worktree、生成声明与未修改测试文件的规则错误影响。本轮日志保存在 `.artifacts/subscription-quota/`。

图标翻面本轮：iOS / Android 构建和 Android 4 项配额定向单测通过；iOS 池内 SE 明暗 UI 回归通过，已复核小环 / 角标截图、翻面与刷新独立、刷新保留周窗口和透明切换。Android API 35 界面回归通过，已复核明暗截图，以及翻面不查询、刷新失败保留周期与读数、两 Agent 隔离。证据位于 `.artifacts/subscription-quota/compact-ui/`，iOS 成功结果为 `ios-161426.xcresult`。

斜轴 3D 动效修订：两端构建、Android 4 项配额单测和两端明暗 UI 回归通过。Android 已复核 60 张实际中间帧，包含侧面实体薄边；预览为 `diagonal-coin-light.gif` / `diagonal-coin-dark.gif`。该轮证据为同目录 `ios-165032.xcresult`、`android-165032-ui.log`，旧直轴版本证据继续保留。

左倾与供应商底板修订：两端构建、Android 4 项配额单测、两端明暗 UI 回归通过；已复核去除行底板的截图及 60 张左倾动画帧。iOS 供应商切换复用 App 共用菜单后，通过普通点击切换断言。最终证据为 `ios-172554.xcresult` 与 `android-171729-ui.log`，预览为 `left-tilt-coin-light.gif` / `left-tilt-coin-dark.gif`；此前 iOS 原生菜单点击失败与 Android 系统弹窗干扰记录继续保留，详见 ADR-0051 r10。
