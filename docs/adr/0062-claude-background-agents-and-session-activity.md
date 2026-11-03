# ADR-0062：Claude 后台子任务与主会话活动

日期：2026-11-03

Status: accepted（用户已授权先写 ADR 再实施；Host、Mod 与双端已接入；设备与真实原生联动门禁未完成，尚未验收）

关联：[ADR-0032](0032-host-owned-agent-state-model.md)、[ADR-0033](0033-claude-code-tui-mods-integration.md)、[ADR-0049](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0055](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0058](0058-shared-interaction-motion.md)。新增 S26；修订 S17–S20、V05、V12、V16–V18，关联 M03、M06、M10、M20、V01–V03、V21。回归 R61，动效 SC45 / MOT-24。

## Context

用户报告 Claude 子代理进入 App 普通会话列表、无法关闭，并且持续输出却显示空闲。Claude 可以在主回合已结束、composer 可接收下一次输入时继续运行后台子代理；因此仅过滤独立卡片或把主回合强制改成 running 都不完整。

当前插件只将无 agentId 的 turn.start / turn.complete 投影为主回合，工具事件却没有保留子代理归属；实时 hello 也没有区分交互 TUI 与非交互执行。Codex / Codex Desktop 与 DeepSeek 已在目录和实时发现排除内部子代理，这个可见会话边界可沿用，执行状态采集不能照搬。

2026-11-03 核对官方 [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)、[生成类型说明](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build)及本机 Claude Code 2.1.317 的公开生成声明：`$.agent.list()` 返回本 Session 的子代理 / teammate，字段包括 id、description、type、status、parentId；状态有 pending / running / waiting / idle / completed / failed / killed。spawn 不是完整生命周期，恢复已有子代理不一定再触发它。独立终端 pane 的 teammate 状态来自 roster，进程消失可能不刷新，不能据此证明仍在运行或已经终止。API 核对不是原生端到端验收。

## Decision

### 1. 三类事实分开

- **主回合 execution.phase**：保持原生 idle / running / waiting_local_interaction，继续决定输入 / follow-up / 主回合 stop；子代理状态不能覆盖它。
- **子任务清单 execution.tasks**：由适配器发布有界完整库存，包含 availability（ready / unknown / unavailable）、items、truncated；每项保存原生 id、可选 parentId、名称 / 类型、状态。身份作用域是 Host / Session / bridge generation / task id。它不是新的普通 Runtime，也不进入历史会话恢复 / 归档 / 批量关闭。
- **会话展示状态**：App 从上述事实生成汇总文字，不能用于命令准入。等待审批优先；主回合运行 + N 个活跃子任务显示“运行中 · N 个子任务”；主回合空闲 + 活跃子任务显示“N 个子任务运行中”（pending / waiting 分别显示启动 / 等待）；仅在库存已确认且没有活跃子任务时显示空闲。未知库存显示“子任务状态待核对”，并保留最后已知清单。

其他后端没有这个来源时不伪造空清单、不改变原状态。协议按 ADR-0032 升为 19，Host / Relay / 双端须配套更新；插件 0.1.6 / bridge 4 要求 agent.list 能力，旧 bridge 不混用。

### 2. 采集、恢复与身份

以 `agent.list()` 为库存来源：首次连接先核对，随后在现有 poll 周期内有界读取，内容不变不重复发布；读取失败发布 unknown 并保留上次值。读取与 HTTP 回执绑定原会话 / generation，串行执行，旧会话、旧连接和迟到返回不能覆盖新库存。仅成功的完整快照可以按缺席移除任务；截断 / 非法 / 不完整不得解释为空，也不得静默丢失活跃项。主回合完成不清空库存；子任务完成不结束主回合。重连 / mod reload 必须重取库存，不能依赖启动事件补齐。独立 pane teammate 的存活未经确认时保留 unknown，不制造“全部完成”。

实时桥仅发布受支持的交互终端会话，非交互子执行不注册普通 Runtime；Host 同样验证来源。主会话中的 agentId 用于任务归属，子代理正文与工具明细不混入主回复。历史扫描继续排除 subagents / sidechain；普通独立会话、同 cwd 多 TUI 不按名称 / 路径相似度合并。

Hook 子代理审批保留准确原生 session / request 身份；只有确定的主会话拥有者才能承载，无法确定时返回原生处理，不新造可关闭会话、不自动批准或丢弃问题。撤下误显示 Runtime 只改变投影，不终止进程、不删除 transcript。

### 3. 双端展示

首页与目录继续一张主会话卡，原状态槽显示汇总活动，辅助功能读出相同信息。聊天页在 composer 附近增加 S26 紧凑子任务区；收起显示活动摘要，展开列出任务名、类型、各自状态和父子关系（有精确 parentId 时）。以任务 id 为 key，同名任务不合并；后台更新不自动展开、抢焦点或滚动正文。空且完整时不占空间，未知 / 失败不能闪成“没有任务”。结果正文仍由主代理原生汇报，首版任务区不宣称具备子 transcript 查看能力。

复用共用折叠、自然高度、按钮按压和材质；SC45 属于 Disclosure / M03 与 ActionGlyph / M20，不新设动画参数。保持 48pt/dp 触控区、明暗、窄屏大字与减少动画；面板有界滚动，不挤没 composer。离页 / 换 Session 重置展开，不以任务更新重置用户选择。

### 4. 控制范围与关闭

主回合 idle 且原生允许时继续发送，即使子任务在工作。主回合 stop 只表示停止该回合，不声称所有子任务停止。当前公开接入尚未验证按 task id 取消的完整回执，因此首版子任务只读，没有无效关闭 / 停止按钮，不用 kill 父进程模拟停止单个子任务。

Host 保留 quit 的进程身份校验，并在子任务活跃、库存未知 / 截断时撤回 quit 能力；直接送来的过期 quit 也必须重新核对后拒绝。说明为“请先在电脑结束子任务，待状态同步后再关闭会话”。这条限制避免无法确认的后台终止范围，不以乐观隐藏冒充结束。没有子任务且取得可核验进程身份时沿用原退出语义。

App 的左滑、选择 / 批量关闭按已确认的 quit 能力启用；能力未就绪或不支持的会话保持可进入，但不先播放关闭再报错。能力变化立即使旧选择失效，批量操作只作用于本次仍有能力的精确 Runtime；Host 最终校验不省略。未知不自动重试。

### 5. 验证与交付边界

1. 原生 Mod：主 idle + 多子 running、主 running + 子任务、pending / waiting / idle / 三种终态、SendMessage 恢复、嵌套同名任务、非交互执行、库存失败 / 超限、Host 重启与会话切换迟到结果。mock 验证与真实隔离 TUI 分别记录。
2. Host / 协议：库存完整性、代次、主回合完成不清任务、子任务不改 phase、重连基线、Hook 归属、无效 / 过期 quit，既有 Codex / DSH 过滤回归。
3. 双端 L1–L4：汇总状态、任务列表、展开稳定、主 idle 仍可发送、无虚假子任务停止、左滑 / 多选关闭能力、断线未知与恢复。不得删改既有断言。
4. 手动 C01–C18、R61 与 A1–A4（布局另查 iPad）：首页不能假空闲，任务区更新不抢阅读位置 / 草稿 / 键盘，审批归属与生命周期正确；同设备同配置基线比较、截图 / 录屏证据存 `.artifacts/ui-regression/20261103-claude-background-agents/`。

未运行、失败、共享池阻塞与原生 API 限制逐项记录；仅单测 / 构建 / 排队不能宣称验收。此 ADR 不授权部署、重启用户 Host 或改动正在使用的 Claude 会话。

## Consequences

主回合可接收输入与后台仍有工作可以同时准确展示。代价是维护独立任务库存及未知状态，而不再用一个 busy 布尔代表全部执行。后续其他后端具备可靠任务来源时可复用同一投影与展示，仍由各自适配器定义控制能力。


## 实施与验证记录（2026-11-03）

- 原生清单在既有 750ms poll 中串行读取，不阻塞主命令轮询；不变清单每 3 秒发送确认心跳，Host 去重投影。读取超过 3 秒、解析失败或超过 256 项均转 unknown；Host 超过 5 秒未收到有效清单即撤回确定性和 quit。重连先发布 unknown，保留最后清单，只有完整 ready 快照可以按缺席移除。退出前及异步进程身份核对后均检查任务门禁。
- 子工具 / 子回合完成保留 agentId、toolCallId；主回合完成只结算主循环审批。孤立子 Hook 或缺少 agentId 的子 transcript 请求交回原生处理，不猜父会话或创建独立卡片。
- 双端复用生产折叠 / 按压组件，以 Runtime + Session 隔离展开状态；主输入 / stop 继续读原 phase。首页左滑、长按选择、批量关闭以及实际发送入口均按 quit 能力核对，能力变化撤销旧选择。
- Node 全量 160 文件、1704 通过 / 5 条件跳过；Claude 官方插件测试 runner 19 / 19（模拟 API，不是实际模型执行），plugin validate、TypeScript 与受影响 ESLint 通过。Swift 359 / 359、Android JVM 689 / 689，iOS Simulator Debug / UI test bundle、Android Debug / AndroidTest 均构建通过。
- 两端共用设备入口均等待 40 秒后被其他任务设备锁阻塞，没有启动设备。L3–L4、C01–C18 / R61 / A1–A4、iPad、同设备基线对照与真实隔离 Claude TUI 子任务联动未运行，不能记验收通过。
- 源码与证据在 `.artifacts/ui-regression/20261103-claude-background-agents/summary.md`；未安装本次包、未部署 Relay 或重启用户 Host。协议升级的启用须随完整配套交付进行，不能只重启旧安装包验证此功能。

## 无设备补验与提交范围（2026-11-04）

用户在再次定向终止旧模拟器仍未退出后，选择保留现场、继续无设备验证，并保留此前提交本次改动的要求。以 `df02972` 为基点建立只含本任务及共享资源解锁文档的独立候选快照，排除其他图标、回答反馈和 Codex 未提交修改；原工作区内容不回退。

候选 Node 全量 1704 通过 / 5 既有条件跳过，官方 Mod runner 19 / 19、TypeScript / 受影响文件 ESLint 通过；Swift 359 / 359、iOS App 与 UI test bundle 构建通过；Android JVM 685 / 685、Debug / AndroidTest 构建通过。Android 比原共享工作区 689 项少的 4 项属于排除的其他任务测试。首次隔离 iOS 构建暴露提交范围漏选 `RuntimeStatusLabel` 文案 / 状态色改动，补入同文件的本任务片段后重新通过，原失败保留。

本轮没有启动模拟器或连接用户 Host，没有执行 L3–L4、C01–C18、R61、A1–A4、同设备基线或真实 Claude TUI 联动。旧 emulator PID 15559 在 SIGTERM / SIGKILL 后仍监听 5680 / 5681，设备保护锁保留；本任务维护锁与所有构建租约均已释放。提交不代表设备验收或部署，S26 保持已实施 / 未验收。证据：`.artifacts/ui-regression/20261104-claude-background-validation/summary.md`。
