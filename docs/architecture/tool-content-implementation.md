# ADR-0045 implementation tickets

依据：[ADR-0045](../adr/0045-tool-summaries-and-on-demand-content.md)。

工作分支：`codex/tool-output-on-demand`。2026-10-27 实现已接通 Protocol、producer、四种后端、Host 和 Android。以下“完成”指本地代码和明确列出的验证；GitHub issue 的关闭、Relay 部署与各客户端升级分别核对，不以构建通过代替运行环境升级。

| Ticket | 实施边界 | 依赖 | 本地结果 |
| --- | --- | --- | --- |
| [#16](https://github.com/WGooold/Orbis/issues/16) | 严格 schema、确定性摘要、库存/读取版本与预算 | 无 | 完成；strict wire 拒绝旧工具全文旁路，投影与字节边界测试通过 |
| [#17](https://github.com/WGooold/Orbis/issues/17) | producer 存储、采集、统一范围接口 | #16 | 完成；配额、缺口、固定版本、租约、取消、崩溃锁回收测试通过 |
| [#18](https://github.com/WGooold/Orbis/issues/18) | Registry、库存分页/增量、历史原子提交 | #16 | 完成；prepared commit、来源失效、分页恢复、200/900 项库存与混合消息顺序测试通过 |
| [#19](https://github.com/WGooold/Orbis/issues/19) | Codex/codexDesktop 投影与原生内容来源 | #17、#18 | 完成；真实 adapter + 原生形状 fixture 覆盖 10 MiB、8 个乱序完成、aggregatedOutput、MCP 和双 Session 配额 |
| [#20](https://github.com/WGooold/Orbis/issues/20) | Pi 扩展采集、loopback 私有读取 | #17、#18 | 完成；10 MiB 不进共享 loopback，SessionManager 参数/结果按需读取、迟到响应隔离测试通过 |
| [#21](https://github.com/WGooold/Orbis/issues/21) | DSH 流式投影与原生历史读取 | #17、#18 | 完成；Web session/page 固定 throughSeq，ACP 事件边界接入，10 MiB 和原生读取复用测试通过 |
| [#22](https://github.com/WGooold/Orbis/issues/22) | Host 设备私有路由、队列及背压 | #17、#18 | 完成；真实 HostService 双设备加密测试确认详情不广播；封帧前预算与取消测试通过 |
| [#23](https://github.com/WGooold/Orbis/issues/23) | Android 摘要、库存恢复、详情、导出与缓存 | #16、#18、#22 | 完成；通用 UI、分页校验、跟随、取消、离线及归属清理接入；模拟器链路验收见下文 |
| [#24](https://github.com/WGooold/Orbis/issues/24) | 硬版本、缓存迁移、构建与验收 | #19–#23 | 本地切换和构建完成；协议 15 / display 3 / tool 1；真实外部后端与公网弱网验收未执行 |

## 最终实现

- `packages/protocol/src/tool-activity.ts` 定义工具身份、摘要、库存和内容读取的 strict schema。摘要最大 4 KiB；库存页/原子增量最多 128 项、业务 JSON 60 KiB，完整响应 64 KiB。参数/结果只能由 locator 私有读取，不接受旧生命周期全文事件进入设备线路。
- `session-source.ts` 的 `RecoverableSessionSource` 将 `live.tools` 替换为空数组及 `live.toolInventory` 引用；混合助手消息按内容块保留正文/工具顺序。摘要字段不变不增加库存 revision，输出增量不逐字节推进聊天 seq。`tool-message-projection.ts` 保留非工具内容、媒体引用和 canonical 额外元数据。
- `ToolContentStore` / `ToolContentCapture` 保留独立的有界原文。每工具 16 MiB、producer 64 MiB/256 个部分、保留 10 分钟、读取租约 30 秒；待写队列 1 MiB/64 项。超限记录明确 UTF-8 字节缺口。OS 证明 PID 已不存在才回收自身锁，其他 producer 目录不受影响。
- `ToolActivityProducer` 统一 Pi/DSH 的采集和确定性历史投影；原生查询只在显式读取时运行。Codex 两种接入使用共同的 `codex-tool-projection.ts`、`codex-tool-content-reader.ts` 与同一 Host producer 配额。原生只有整页 RPC 时明确标记 whole-source，不声称上游已提供范围 RPC。
- `AgentToolInventory` / `ToolInventoryIngestion` 在 Host 私有组装固定页，再与 conversation 的 Entry/head/工具移除共同提交。Registry tools 域只存有界描述符。每 Session 4096 项/8 MiB，全 Host 16384 项/32 MiB；过大的原子增量触发固定基线恢复。
- `ToolContentService` 先验证设备、Session 和 locator 的归属；每设备 2 个在途读取、每查看器 1 个、64 个租约。`PiToolContentReader` 使用 Host 内部关联身份，未知/迟到响应在共享分发之前被消费。关闭路径、runtime 或设备释放对应读取和库存快照。
- `DeviceLink.sendToolContent` 单独计入每设备 256 KiB 的保守密文封装预算，封帧前准入，详情走 bulk。Android `InboundFrameLanes` 保留 bulk data 文本与 bin 字节类型，共用低优先级和预算，分别交 reducer 和 artifact 处理器。
- Android 只渲染标准摘要，工具详情切换参数/输出/最终结果；每页请求 32 KiB、查看器缓存 2 MiB。JSON 页显示为可选择的 UTF-8 文本片段，不能单页当完整结构化结果解析。显式跟随在当前末尾以 750 ms 查询，分页间隔 50 ms；关闭、后台、会话/Host 切换停止请求。断线保留可见缓存并标记离线。
- 导出经系统文档创建器授权目标文件，以固定读取身份逐页写入、显示进度、支持取消，上限 64 MiB；不把全文累积进查看器或聊天数据库，缺口/取消删除本次未完成文件。
- 硬协议 15、显示投影 3、工具投影 1；新 source epoch 在 SQLite 一笔事务中清除旧 canonical/display/cursor/timing/coverage，再写新基线。事务失败回滚，保留配对和身份。

## 验证与产物

Windows Node 路径为 `C:\nvm4w\nodejs\node.exe`。`npm run build`、`npm run typecheck`、`npm run lint` 通过；构建/类型检查与 Vitest 串行执行，最终全量 Vitest 133 个文件、1327 项全部通过。

Android 经仓库后台构建入口完成 `testDebugUnitTest`、`assembleDebug` 和 `assembleDebugAndroidTest`，51 个单元测试套件、474 项全部通过。设备安装经 `android-install.ps1` 校验工作树和 SHA-256，没有卸载、清数据或修改已有配对。

设备验收使用独占 API 35 模拟器、真实 Android 连接/加密/reducer/SQLite，以及 `scripts/tool-content-fixture.mjs` 中独立的合成原生来源。该进程使用真实 DeviceLink、Host 库存/事务和私有内容服务，不连接用户 Host，也不读取真实会话。

- 四种 agentKind 各 200 项清单，均分两页接收；未打开详情前原文请求数为 0。
- 首两页各读 32 KiB；详情读取前后 conversation 完全相等。
- Pi 路径按页导出 10 MiB 加 18 字节前缀，查看器不累积全文；关闭后不再产生请求。
- 取消导出后删除未完成文件且停止后续请求；工具投影升级失败回滚，重开 store 后只有新摘要，无旧工具原文，配对身份保留。38 项 SQLite/同步选择设备回归另外验证 epoch、cursor、coverage 和条件同步。
- 加密详情队列峰值约 69 KiB，低于 256 KiB；该数是此合成场景的实测，不是所有公网链路的上界证明。
- HostService 的双设备测试验证只有发起设备接收私有库存页/详情；生产服务的权限边界也被测试，而不仅是 fixture。

最终设备验收为 `OK (40 tests)`，无失败：2 项工具内容/迁移测试与 38 项 SQLite/同步选择回归全部通过。四种 agentKind 各取得 2 页库存；详情发送队列峰值为 69,328 字节。测试来源进程、独占模拟器及内存监控均已退出，对应设备占用已释放，保留 AVD 和已有 App 数据。

设备测试的可复现入口、资源占用与结果判定见[工具内容设备验收](../testing/tool-content.md)。本地产物只在 `.artifacts/app/`（APK、测试 APK、校验/证据）与 `.artifacts/host/`（可运行便携包、zip、SHA-256 与 smoke 证据）；两处的 `verification.md` 记录构建时的结果和边界。该设备验收本身不更新用户 Host。

Windows 便携包构建通过 4 项原生 Qt 测试和 portable smoke。worktree 的 node_modules 指向主目录时，`package-host-runtime.mjs` 将已验证的 node_modules 后缀转换为包内相对路径，避免 Windows 跨盘 absolute 路径进入 ZIP；workspace 依赖仍从本 worktree dist 打包。

## 诊断范围与尚无证据的部分

Host 每 30 秒按 agent scope 记录 `tool.content` 计数，最多暂存 256 个 runtime：`summaryJsonBytes` 是 producer 库存页的 JSON 业务字节，`bodyJsonBytes` 是进入 Host 的 patch.live.messages JSON 字节，`detailJsonBytes` 是已准入私有内容页 JSON 字节；不是所有 snapshot/history 的统计，也不是密文线路流量。另有读取次数、失败、缺口响应数及 Host producer 的保留量/队列/租约/配额命中；store 的 `cacheHits` 指携带固定读取身份的续读。Pi 扩展独立 store 的占用没有并入 Host store 总计。

fixture 的 `wireBytes` 统计发给模拟器的完整 v2.frame JSON 字节，包含摘要、控制消息及显式详情；其中导出流量占大部分。没有同输入下旧版本完整线路的比较结果，不报告固定节省百分比。

没有执行真实 Pi/Codex/桌面 Codex/DSH 外部服务的模型回合，也没有执行生产 Relay、公网慢链路或真实进程崩溃/重启矩阵。上述后端测试是原生形状 fixture，设备测试是实际 Android 与合成 Host 来源，不将其写成真实外部后端验收。

工具原文引发的 metadata 膨胀已从共享路径移除；超长助手正文、思考和非工具 live 仍可能超过现有页预算并产生 `session_metadata_too_large`，不在本 ADR 的修复范围。协议 15 要求 Host、Relay 和 App 配套升级；部署时须核对 Actions、公网健康检查、服务器部署标记及本机实际加载的运行代码。
