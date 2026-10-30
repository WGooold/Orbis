# Claude Code 供应商与官方订阅配额

2026-10-30。参考仓库拉取在 `../cc-switch`，固定版本 `4ed071500b07ba5801be84c96ddb4e03bdf48a2d`。配置字段归属参考 `src-tauri/src/live/floor.rs` 和 `live/project/claude.rs`；配额接口与凭据格式参考 `services/subscription.rs`。

## 使用入口

- Host：Agent → Claude Code → 供应商配置。可以导入当前配置、添加预设或自定义配置、编辑、复制、排序和启用；官方预设使用 CLI 中已登录的 Claude 账号。原生 Anthropic Messages 预设共 126 个，不包含需要 CC Switch 代理转换或专属 OAuth 的预设。
- iOS / Android：设置 → 供应商 → Claude Code。手机可以切换 Host 已保存的供应商。
- Claude Code / Codex 当前启用的官方配置卡片显示“查询订阅配额”。Host 弹窗、iOS 和 Android 均显示 5 小时配额、周配额的剩余百分比、重置时间和查询时间。API Key 登录没有订阅配额，会提示登录官方订阅账号。
- Claude Code 切换影响重新打开的会话；运行中的任务或待确认权限会阻止切换。项目级配置、终端启动参数和独立终端环境变量仍遵循 Claude Code 自身的优先级。

## 配置与凭据

Host 使用现有 `providers.json` 目录和事务日志管理 Claude 的 `settings.json`，尊重 `CLAUDE_CONFIG_DIR`。切走前回填供应商字段；切换时替换路由、认证、模型映射和供应商自有字段，保留 Hooks、权限、插件、MCP 与其他共享设置。写入失败或重载失败回滚；检测到外部修改时拒绝覆盖。OAuth 凭据文件与系统钥匙串不参与供应商切换。

配额查询复用 Host 进程内的供应商锁，并合并同一配置的并发查询。请求只包含 Agent、已保存的供应商 ID 和请求 ID；手机不能提供 URL、配置或凭据。服务端重新核对当前配置，分类标签不能伪装官方供应商。

Claude 使用当前目录的 `.credentials.json` 或 macOS 钥匙串，也支持原生配置中的 `CLAUDE_CODE_OAUTH_TOKEN`。Codex 使用当前 `auth.json`；macOS 支持按 `CODEX_HOME` 区分的 `Codex Auth` 钥匙串条目。Host 托管的 Codex 账号启用后同样查询 CLI 当前登录，查询操作不会在后台轮换 CLI 的刷新令牌。非 macOS 的显式 keyring 存储会提示改用 CLI 文件登录存储，默认文件登录可直接查询。过期或被拒绝的登录会提示到 CLI 重新登录。

固定查询端点分别为 `https://api.anthropic.com/api/oauth/usage` 与 `https://chatgpt.com/backend-api/wham/usage`，禁止重定向，限制响应大小与查询时间。手机仅收到两个标准化窗口的有限数字和时间，错误消息不携带凭据、URL 或原始响应正文。

Codex 按窗口实际时长识别 5 小时 / 7 天，不按 primary / secondary 的位置猜测。缺失、未知时长、无效数字显示“暂不可用”；Codex 用量为 0 时不展示可能是占位值的重置时间。手机在断线、切换电脑、切换 Agent 或供应商后丢弃旧查询；失败不阻止再次查询。

## 本地验证

新增回归覆盖 Claude 配置回填、共享字段保留、原子回滚、外部编辑冲突、官方配置识别、模型映射、配额窗口与缺失值、固定端点、错误脱敏、查询合并及与切换串行化。加密链路测试覆盖 Claude 切换和配额响应；iOS / Android 状态测试覆盖响应关联和跨电脑隔离。

验证使用隔离目录、测试登录数据和模拟配额响应；未调用个人账号的真实订阅接口。接口的服务端可用性和真实套餐响应需要使用已登录账号验收。

本轮验证：TypeScript 类型检查、Host / Protocol 源码 lint、92 项相关后端回归、193 项 Swift 测试、499 项 Android 单元测试和 4 项 Host CTest 通过；iOS 模拟器 App、Android Debug APK 和 macOS Qt Host 构建通过。全量 Vitest 为 1448 通过、5 跳过、11 失败；11 个失败在独立的原始 HEAD 副本中全部复现，涉及既有 Windows 路径/终端假设和目录会话测试。全仓 lint 另受已有 worktree、生成声明与未修改测试文件的规则错误影响。本轮日志保存在 `.artifacts/subscription-quota/`。
