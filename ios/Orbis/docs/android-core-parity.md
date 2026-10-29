# iOS / Android 核心数据与 Host 交互对齐

日期：2026-10-29。以 Android 当前仓库实现为基准，对齐底层数据、协议、存储和 Host 交互；同步接通缺少的 SwiftUI 功能入口。
参考 Android 同一提交的实现和现有 ADR，继续使用协议 v15，不增加 Host 私有分支。

## 已实现范围

| 范围 | iOS 行为 | 主要源码 |
| --- | --- | --- |
| 路径与认证 | Relay / LAN / 原生 WebRTC DataChannel 各自握手、密钥、序号、分片和回压；加密 Relay 信令、LAN 认证发现、Host 选路与独立重连/回退；旧配对请求不能影响新连接 | `WebSocketTransport.swift`、`P2PTransport.swift` |
| 入站调度 | ctl / msg / bulk 独立有界队列，控制优先；会话或控制帧丢失触发可见会话恢复并限频，bulk 由范围重传补齐 | `WebSocketTransport.swift`、`OrbisStore.swift` |
| 会话统一模型 | 相关请求/订阅、模型代次和逐领域版本；原子验证，独立合并；缺席/未知/部分清单区别处理；重连可重新投影 unchanged；认证 ready 可以更换 Host 模型代次 | `AgentState.swift`、`HostState.swift` |
| 模型消费 | 执行、模型与思考级别、上下文、权限、Slash 能力、审批、steer / follow-up 队列；已受模型管理的字段不会被迟到旧事件覆盖；资源和引用保留领域 envelope | `AgentState.swift`、`OrbisStore.swift` |
| 目录分页 | 固定 epoch / revision / snapshot / offset；拒绝旧请求、重复会话、循环游标和无进展页；未完成目录保留已知会话；完整后端才允许清理缺席项，在线或缓存历史仍保留 | `HostCatalog.swift`、`HostState.swift` |
| 历史缓存 | 后台 SQLite 增量事务一起保存 canonical parent、显示投影和 timing；按 Host / 配对隔离，有界首屏和旧页查询、JSON 缓存迁移；缓存不建立 live applied baseline；完整保留 canonical JSON 大整数；压缩窗口用数据库祖先证明剔除旧显示内容 | `SessionHistory.swift`、`SessionHistoryStorage.swift` |
| 逻辑读取 | 首屏、source 核对、历史分页和固定目标 catchup 分开拥有身份、分支/缓存/连接代次与终态；本地优先、远端接力；catchup 以前向有界页持久推进，不移动 live/head；字节限额页、旧页期间实时追加、超时与迟到恢复 | `SessionReadOperations.swift`、`OrbisStore.swift` |
| 同步事务 | 不变参数和稳定 commandId / syncId 重试；处理 Host pending / lease；保留迟到结果关联；SQLite 提交及精确工具库存版本证明均完成后才回执 applied；工具失败有终态，等待期间的刷新需求会接力；条件已应用基线用于后续核对 | `SessionHistory.swift`、`OrbisStore.swift` |
| 通知 | 独立 Host epoch / revision；完整清单替换，未核对清单仅接受 Host 明确移除；关闭请求后等待权威结果；有界重试；不从聊天内容或设备时钟推断恢复 | `Notifications.swift` |
| 下载 | 有界接收窗口、乱序缓存、连续写盘前缀、最旧缺片指数退避补取；每任务 worker 串行写盘与同步后发布持久进度，取消/重试代次隔离；恢复 offset / hash 验证；空文件及失败回执处理 | `FileTransfers.swift` |
| 上传 | 后台建立私有副本与 SHA-256、Host 持久进度与恢复范围验证；迟到失败不能覆盖完成/取消终态；配对身份变化暂停旧任务 | `FileTransfers.swift` |
| 工具库存 | 固定页版本和补丁连续性；有界保留精确已验证版本证明；旧引用不回滚；新 checkpoint 不反复打断分页；失败/过期释放等待回执 | `ToolInventory.swift` |
| 工具详情 | read / viewer / request 身份、UTF-8 字节范围、缺口及版本验证；流式文件导出，上限 64 MiB，后台串行写盘、进度/取消、完整后发布文件 | `ToolContent.swift` |
| 多 Host 与本地上下文 | 每台 Host 独立常驻连接、状态和传输任务；选择 Host 不重连；相同 runtime/session ID 隔离；配对草稿、交互输入、缓存及上次选择；取消配对仅清所属 Host，异步清理可等待 | `OrbisHub.swift`、`OrbisStore.swift` |
| 功能入口 | 多 Host 主页、离线会话与分支、历史分页/预览、队列撤回、通知关闭、执行/模型/上下文/timing、Desktop 接入原因、工具导出与分享、手动路径下载、截断提示与按需全文、工具参数和结果关联；普通交互草稿持久化、敏感输入仅内存 | SwiftUI 页面、`Presentation.swift` |

以上是对现有 ADR-0007、0013、0025、0026、0028、0029、0032、0037、0040、0045 的客户端实现，未改变协议架构。

## 验证

`bash scripts/check-ios.sh` 运行同源 Swift 核心测试、源文件/工程配置检查，并在有完整 Xcode 时构建模拟器 App。
新增回归覆盖固定目录范围、模型版本/代次/订阅、缓存隔离与提交失败、同步重试/租约/迟到回执、下载乱序/补片、工具库存与详情导出、通知清单。
真实本地 Node WebSocket 夹具验证 Relay 根路径和代理前缀、配对与加密分片、Host 重启、LAN 认证发现/握手、Host 选路、断开一路后另一路继续工作及回退。

2026-10-29 执行 `bash scripts/check-ios.sh` 通过：172 项 Swift 核心测试、16 个 suite；源解析、plist / scheme / 工程检查及 iOS Simulator Debug 构建全部通过。日志：`/tmp/orbis-final-check-ios.log`。

原生网络回环另外使用锁定的 WebRTC 140.0.0 与 node-datachannel 0.33.4；覆盖加密信令、HS1/2/3、文本/二进制分片、Relay 丢失恢复和双 Host peer 隔离。24 项原生传输回归全部通过（包含实际双 Host WebRTC 与 Relay，不是跳过的条件用例），日志：`/tmp/orbis-final-native-transport-tests.log`。可复现命令见 iOS README。

专用 Orbis Core Parity 模拟器完整 UI 回归 13/13 通过（含浅深色截图）。已实际检查交互输入、普通/敏感草稿、队列撤回、通知关闭、工具导出保留正文、截断全文和 Desktop 原因；页面截图经过检查。结果包：`.scratch/ui-parity-complete-verified.xcresult`。

2026-10-29 补充普通启动验证：修复 Debug / Release 缺少 `@executable_path/Frameworks` 导致 WebRTC 无法加载的问题。旧产物在脱离测试器直接启动时重现 DYLD 崩溃；修复后同一专用模拟器直接启动并显示界面，iPhoneOS Debug / Release 无签名构建及运行时依赖检查均通过。`check-ios.sh` 现包含包内动态库依赖检查，可检出旧产物；此前 UI 测试器提供的库搜索路径不能代替普通启动验证。

## 平台边界与现场验收

- iOS 后台执行、系统通知和权限遵循系统生命周期；没有新增 APNs 或假设 Android 前台服务在 iOS 可直接复用。
- 跨 NAT / 蜂窝网络打洞、真机前后台切换、长会话、弱网和存储压力仍需真实 Host / iPhone 现场验收。本地网络回环和模拟器测试不能替代这些结果。
- 实际 UI 表现的覆盖范围与剩余渲染差异见 `android-ui-parity.md`；本轮以功能和字段消费为目标，没有承诺像素一致或完整 CommonMark 渲染移植。
