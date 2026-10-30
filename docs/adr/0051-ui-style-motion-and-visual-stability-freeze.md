# ADR-0051：UI 风格、动效与画面稳定性 feature 冻结基线

日期：2026-10-30

Status: accepted（基线冻结；新增与变更按本文维护）

基线版本：`2026-10-30/r12`。盘点参照：`main` 的 `3a5bbf5`、已有 accepted ADR 及下列实现入口。

## Context

UI 约束分散在 ADR-0042、0046–0049、移动端验收、历史设计稿、覆盖审计和后续代码中。
只查旧设计稿会恢复已经替换的消息形态和嵌套阴影；只优化打开速度又可能删除既有转场、破坏阅读位置。
批量选择、左滑关闭、选择性触觉和即时按压反馈也需要有可检索、可维护的共同基线。

本 ADR 单独汇总并冻结这些 feature，供模型在设计、实现、重构和修复时先查阅。
范围包含 iOS / Android 全部应用页面，以及品牌资源、macOS / Windows Host 和 Relay 公共站点 / 管理台的视觉规则。
协议和业务功能只登记影响显示身份、反馈真实性和画面稳定性的部分，完整契约仍由各专题 ADR 负责。
盘点不把工作区中尚未完成的改动、历史备选主题或待实施建议认定为已交付 feature。

## Decision

### 1. 冻结含义与文档关系

- 本文是 UI 基线的统一入口；表中“冻结规则”是后续改动必须保持的行为，不代表本次重新完成了所有设备验收。
- 原专题 ADR 保留其背景、状态 / 协议细节和验证证据。本文汇总 ADR-0046 的全部 17 项要求，补入后续 feature；不废弃那些决策。
- 新需求可以演进基线。在用户已授权的任务范围内完成设计和修改，同时记录决策、影响与验证；不因“冻结”额外制造确认流程。
- 修复实现偏离时恢复基线；新增页面继承共用规则。不得以性能优化、组件替换或平台对齐为由，静默删除动效、改写视觉层级或放宽稳定性约束。
- 历史稿中的平面备选主题、旧字号、旧消息气泡 / 左侧标识线、逐层加影，以及旧设置中的可调连接优先级，不是当前要求。路由与设置按 [ADR-0050][D50]。
- 本文明确收录后续源码和测试已落地的转场行为：M07、M08、V13 补充 ADR-0048；其早期“入场期间禁用返回拖拽”“结束后释放首页底层”的描述由本文取代，见该 ADR 的关联修订。
- 源码、本文与专题 ADR 冲突时，先查相应修订及证据，记录差异并在本次任务中统一；不能把偶然实现或较旧截图自动升级为新标准。

### 2. Feature 统计与稳定编号

以可独立维护的约束组为一项，不按按钮数量、页面数量或两端实现重复计数。
共 **60 项**；编号固定，后续只追加，废弃项保留编号并标明替代关系。

| 分类 | 编号 | 项数 | 适用范围 |
| --- | --- | ---: | --- |
| UI 风格与布局 | S01–S20 | 20 | iOS / Android |
| 动效、手势与反馈 | M01–M12 | 12 | iOS / Android，保留注明的平台差异 |
| 画面与状态稳定性 | V01–V18 | 18 | iOS / Android 及相关投影 / 状态边界 |
| 品牌、桌面端与网页 | X01–X10 | 10 | 共用资源、Host、Relay |
| 合计 | | **60** | 移动端 50 项，其他表面 10 项 |

ADR-0046 原 17 项要求的映射：1→V01–V04；2→S02；3→S03；4→V05–V08；5→S09；
6→S01 / S04；7→S12；8→M04；9→S07；10→S06；11→M03；12→S08；
13→M01–M02；14→M05；15–16→S16；17→S05。

### 3. UI 风格与布局：20 项

| ID | Feature | 冻结规则 | 来源 / 实现入口 |
| --- | --- | --- | --- |
| S01 | 明暗四层底板 | 浅色 `#DDE3EF / #E6EBF4 / #EDF1F8 / #F3F6FB`；深色 `#1C1F26 / #23262E / #292D36 / #2F333D`。共用连续底板，相邻层微明度区分。 | [D46] §2、[iOS 设计组件][I1]、[Android 主题][A1] |
| S02 | 单一材质外框 | 独立卡片 / 面板最外层凸起或凹陷，后代按环境层级平铺；页面地面、文字和行内内容保持平面。不能清空材质环境来叠第二层阴影；独立菜单 / 弹窗才建立新的表面根。 | [D46] §2、[I1]、[Android 材质][A2] |
| S03 | 同心圆角 | 共用控件 16、卡片 / 菜单 24、对话框 32，iOS sheet 28；子圆角为父圆角减声明的内容内距，圆形与胶囊保留自身几何。距离在 iOS 为 pt、Android 为 dp。 | [I1]、[Android 共用 UI][A3]、[D46] §2 |
| S04 | 柔影与带色遮罩 | 保持左上高光 / 右下暗影、凹槽内影的光源方向；应用绘制的投影和遮罩用带色墨色，不用纯黑硬边塑造层次。图片本体与系统界面不重着色。 | [D46] §2、[材质审计][Audit]、[I1]、[A2] |
| S05 | 四档界面字号 | 只有 `20 / 15 / 13 / 12` 四档，最小 12；用字重、颜色、间距补层级。图形尺寸不计为文字字号，不能为局部页面另建字号体系。 | [D46] §3、[I1]、[A1] |
| S06 | 等宽数字 | 计数、耗时、大小、百分比和时间采用等宽数字，避免数字变化挤动相邻内容。代码 / 路径需要时使用等宽字体。 | [D46] §3、[I1]、[A1] |
| S07 | 图标光学校正 | 文字旁图标按 `0.125em` 规则对齐；iOS 使用首行基线，独立图标按钮保持居中。 | [D46] §3、[I1]、[Android 打磨组件][A4] |
| S08 | 原生文字语义与断行 | Android 使用原生 Paragraph，iOS 使用系统文本断行；保留选择、复制、链接和辅助功能语义，不靠插入空格 / 换行模拟排版。 | [D46] §3–4、[iOS 聊天][I2]、[Android Markdown][A5] |
| S09 | 扩展名与完整文件名 | 主名和最后一个扩展名分开布局，只省略主名；点文件、尾随点不算扩展名。附件、产物、文件浏览、下载共用规则，辅助功能提供完整名称。 | [D46] §3、[I1]、[A4] |
| S10 | 用户 / 助手消息形态 | 用户消息靠右、按内容收窄，使用凹陷气泡；Android 最宽约 85%，iOS 通过至少 36pt 外侧留白区分作者。助手按轮次使用一层浅凸起面，内部正文平铺，保留 Agent 标识与回复复制入口。用户消息保留复制及可用时的 Rewind。 | [iOS 聊天][I2]、[Android 页面][A6]、[对齐记录][Parity] |
| S11 | Markdown 阅读层次 | 代码 / 引用 / 表格 / 图片遵守嵌套平铺；表格用行底色区分，取消逐格框；代码保留横向滚动、等宽排版与就近复制，正文链接不另生成重复下载按钮。 | [D46] §2、[I2]、[A5]、[Audit] |
| S12 | 柔和输入焦点 | 输入框为凹槽，聚焦加深并显示柔和的强调色双环，错误仍有明确文字 / 颜色，不用黑色硬描边；搜索、问卷和 composer 复用共用组件。 | [D46] §2、[I1]、[A3]、[A4] |
| S13 | 可见几何与触控区 | 共用普通操作触控规范 48、输入最小高度 56；可见圆面与命中区分开计算，阴影不参与布局尺寸。系统控件遵循平台契约，不能用缩小触控区来塞入窄屏。 | [A3]、[I1]、[Audit]、[Parity] |
| S14 | 卡片旁小操作 | 仍需外置的目录新建 / 会话菜单等与卡片同级：可见圆面 36、图标 18、触控区 48、浅阴影；约 6 的可见间距来自触控区留白，不另叠 12。供应商动作预留等宽槽。正文复制、通知关闭、表单和弹窗动作继续就近放置；已移除的别名按钮不恢复，下载整卡操作按 S20。 | [D46] §2 补充、[打磨验收][Polish]、[Audit]、[A6]、[iOS 下载][I8] |
| S15 | 批量选择视觉 | 卡片保持原材质，选中覆盖 7% 主色底和 1 单位细描边；右侧常驻 22 的圆形标记槽，不通过插入复选框、缩放或平移改变几何。覆盖主页关闭、目录归档 / 恢复、下载删除、供应商移除。 | [I1]、[A2]、[Audit] |
| S16 | 简洁文案 | 不生成 UI 中点分隔符、重复操作说明、无意义零任务提示；状态和投递方式使用一致的中文。不得改写 Host / Agent 正文，也不能为精简文案隐藏错误、截断或来源未知。 | [D46] §3、[Polish]、[I2]、[A6] |
| S17 | 聊天顶栏与输入结构 | 顶栏维持标题 / 状态层级；输入上方的目录、Git 分支和轻量权限入口共用安静的信息区，长路径保留可辨识的尾部，分支保留名字；附件、输入、发送 / 停止同一行。Android 窄屏 / 大字体可堆叠信息区，不能重建已打开的权限面板。 | [I2]、[Android 输入信息区][A7]、[A6] |
| S18 | 当前电脑与连接显示 | 主页 / 目录仅显示当前电脑；顶部固定电脑行，多电脑可切换，其他电脑待确认用红点并在菜单指明归属。连接胶囊按实际状态表达连接方式与加密，不把“正在连接”画成已安全连接。 | [ADR-0030][D30]、[Polish]、[iOS 页面][I3]、[A6] |
| S19 | 目录与设置层次 | 目录及其会话按最近修改排序，一次展开一个目录，先展示最近 5 条再显式展开余项；会话卡片填满所属列表宽度，标题统一预留两行，短标题不收缩、超长尾部省略；相同字号下等高，按两行文本自然高度布局，不硬编码整卡高度。会话行保留 Agent、单行状态、中文相对时间及不同 provider 提示。连接策略固定 LAN 优先、Relay 兜底，不提供排序设置或空设置页；连接信息与供应商集中在状态页，用连续事实行展示。连接状态页按 Agent 展示当前供应商、Agent 图标和切换入口；所有供应商行共用一张外层卡片，行内透明、无独立白底或阴影；Codex / Claude 官方供应商将 44pt/dp 细线配额环围在 Agent 图标外，周期（5h / 周）和百分比均为 12pt/sp 角标，64×56pt/dp 图标操作区独立于整卡刷新与供应商切换。无读数时点图标也查询，有读数后点图标沿左倾 24° 斜轴进行 560ms 三维硬币翻面（220ms 翻出、340ms 缓入），只有图标和圆环转动，周期 / 百分比角标原位淡化；局部薄边、扫光和仅翻转时出现的接触影表达厚度与抬起，额外轻倾 4°、最大抬起 2pt/dp、放大 3.5%，不增加卡片层级或改变命中区；首次成功获得双窗口读数后演示 5h → 周 → 5h 两次翻面，中途操作立即接管，后续刷新保留当前周期。刷新图标轻摆、按压反馈和查询圆弧旋转提示可操作，不添加可见点击说明；切换为无底色图标文字，保留 48pt/dp 命中区；两端复用共用菜单层，离开、切换电脑或清单失效时关闭菜单。结果圆弧 700ms 过渡至实际比例；失败保留旧读数。减少 / 关闭动画时跳过演示与三维旋转，点击直接切换；离开、切换供应商与重新查询取消演示。 | [Parity]、[Polish]、[iOS 会话页][I4]、[Android 抽屉][A8]、[D50]、[iOS 状态页][I9]、[Android 状态页][A19] |
| S20 | 新建、工具与文件入口 | 新建 Agent 选项采用共用网格与可用性提示；工具名称 / 状态为紧凑摘要，thinking / 工具正文可展开，详情分页 / 导出和截断内容取全文保持独立入口。下载整卡轻点暂停 / 继续 / 重试，长按多选，取消保留续传数据；iOS 完成卡可轻点分享，不恢复旧旁置下载按钮。附件、浏览器、历史预览复用共用材质与文件名组件。 | [Parity]、[Polish]、[ADR-0045][D45]、[I2]、[A6]、[I8] |

### 4. 动效、手势与反馈：12 项

| ID | Feature | 冻结规则 | 来源 / 实现入口 |
| --- | --- | --- | --- |
| M01 | 自定义拖拽回位 | 通用回位弹簧质量 1、刚度 1200、阻尼 80；不要用此通用参数覆盖 M08 的页面返回弹簧。原生系统键盘、抽屉、模态手势继续由平台控制。 | [D46] §4、[I1]、[A4] |
| M02 | 勾选小反馈 | 共用确认 / 勾选弹簧刚度 380、阻尼 18，轻微回弹；只改变图形呈现，不改变容器尺寸或业务完成状态。 | [D46] §4、[I1]、[A2]、[A4] |
| M03 | 自然高度折叠 | 首次展开才创建 / 测量正文，以约 260ms 在零高与自然高度间裁切插值；之后保持内容身份、草稿和内部状态。支持快速反转，隐藏内容不暴露可操作语义。 | [ADR-0047][D47]、[I1]、[A4] |
| M04 | 流式新增字形渐显 | 只对新追加字素做 6pt/dp 模糊渐显：单字 120ms、间隔 30ms、批量等待最多 450ms；Android 活动范围有界，至多末尾 128 个字素。历史 / 既有文字及布局尺寸不动画。iOS 18+ TextRenderer，17 直接显示；尊重系统减少 / 关闭动画。 | [D46] §4、[I2]、[Android 流式文本][A9] |
| M05 | 复制反馈恢复 | 原位置同尺寸替换为成功对勾，2.5 秒后恢复；重复复制重置计时，离开取消旧任务；失败不能冒充成功，也不能按成功计时静默清除。 | [D46] §4、[I1]、[A5] |
| M06 | 选择模式淡入 | 选中 tint、细描边和标记用约 160ms 淡入 / 替换，不动卡片深度和尺寸；选择模式只替换现有顶栏 / 状态区，取消确认保留当前选择。 | [I1]、[A2]、[Audit] |
| M07 | 聊天入场 | 保留聊天从右向左的入场和首页底层压缩 / 遮罩，每次重入仍播放；不等待源端同步。Android 入场可被右滑接管，手指按住后停止入场并跟手；首页保持同一组合身份，动画帧不反复重建页面。iOS 保留原生导航入场。 | [ADR-0048][D48] 及后续修订、[Android 返回层][A10]、[转场测试][T1] |
| M08 | 交互式右滑返回 | 页面跟手，按位移加约 0.15 秒速度预测，超过约三分之一宽度返回；超出整屏的拖动用 0.18 阻力。取消用质量 1 / 刚度 260 / 阻尼 24 的回弹；底层首页由 `scaleX=0.975 / scaleY=1.008` 和最高 0.34 遮罩恢复。iOS 返回吸附结束再切页；Android 确认返回用 180ms 退场，结束即恢复首页交互，不能留下透明聊天层挡点击。 | [I3]、[A10]、[T1] |
| M09 | 目录抽屉跟手与收缩 | 主页左缘右拖打开、抽屉或遮罩左拖关闭，位置 / 速度决定吸附；竖向列表滚动不带动抽屉。折叠目录后内容高度立即收缩，不等下一次手势；目录保持虚拟化。 | [Parity]、[I3]、[I4]、[A8] |
| M10 | 首页左滑关闭 | 只接管左向起始拖动，右拖仍可打开目录；逐步显露关闭区，达到卡片半宽提示“松手关闭”，退回阈值内则取消，松手才提交。保留取消回弹 / 关闭退场及单次越阈值触觉；多选模式不触发左滑关闭。 | [I3]、[A6]、[Android 关闭手势][A11]、[ADR-0049][D49] |
| M11 | 即时按压反馈 | 普通按压沿用凸起 / 凹陷替换，选中与禁用不改变尺寸。Android 可滚动卡片按下即显示反馈，观察拖动消费后立即取消；不消费手势来制造按压，不能误触点击、长按或阻断列表。 | [I1]、[A2]、[Android 按压观察][A12] |
| M12 | 选择性触觉 | 只在发送 / 停止 / 审批等明确提交、进入批量选择或左滑关闭越过阈值等节点反馈；普通导航、展开、逐项选择不统一加震动。iOS 为 medium 完整强度，Android 为系统 LONG_PRESS；复用共用入口，不把触觉当作源端成功回执。 | [I1] `OrbisHaptics`、[Android 触觉][A13]、提交 `a7b07bf` / `76c01d3` |

### 5. 画面与状态稳定性：18 项

| ID | Feature | 冻结规则 | 来源 / 实现入口 |
| --- | --- | --- | --- |
| V01 | 像素距离跟随 | 以内容末尾到视口的实际距离判断，回到一行内才可恢复跟随；离末尾超过三行显示“回到最新”，显式点击跳转并恢复。不能用“最后一项可见”或消息数量代替距离。 | [D46] §1、[I2]、[A4]、[A6] |
| V02 | 阅读锚点锁定 | 用户拖动即停跟随，惯性期间持续生效；保存消息身份与行内像素偏移，补页 / 刷新不重放用户移动前的位置。停稳后锁定新位置，锁的是内容坐标，不是禁止滚动。 | [D46] §1、[I2]、[A6] |
| V03 | 更新不抢回底部 | 底部新增消息、工具、流式字形、发送、聚焦、刷新和同会话分支动作均不能强制追新；临时空投影 / 内容变短不能自动恢复跟随。前缀补入仅校正原锚点。 | [D46] §1、[I2]、[A6] |
| V04 | 分页边沿与显式加载 | 进入顶部区域的边沿只取一页，离开后才重新武装；停在顶部、重组、释放锚点不连续续页。顶部保留更早历史 / 加载 / 失败重试入口，失败不自动重试。 | [ADR-0041][D41]、[I2]、[Android 分页][A14] |
| V05 | 刷新顶栏固定槽 | 转圈复用行首状态图标槽，不追加在模型后；刷新前后状态、模型、思考级别的文字宽度及省略位置不变，状态单行。错误摘要留原槽，可打开详情 / 重试。聊天、首页与目录的状态槽在 Host `execution.compaction.phase=running` 且执行为 idle / running 时显示“压缩中”，沿用运行中强调色；等待确认优先。压缩 idle / failed / unavailable 或执行域不可用后退出该显示，不据此推断业务执行完成，不改发送 / 停止所用 phase。 | [D46] §3、[I2]、[A6]、[顶栏测试][T2] |
| V06 | 通知与短反馈覆盖 | 通知为有底色、有关闭按钮的覆盖横幅，短操作反馈覆盖现有区域，不插入聊天消息行推动正文；来源未知 / 待核对仍明确显示。 | [D46] §3、[Polish]、[I2]、[A6] |
| V07 | 审批面板与草稿 | 单项确认紧凑浮于输入区上方，多步骤在工作区切换并保留各项草稿；提交中不挤动 composer，不常驻无内容占位。解决、失败、截止和本地 / 远端竞答以真实状态处理。 | [Polish]、[Parity]、[iOS 交互][I5]、[Android 交互][A15] |
| V08 | 键盘、安全区与正常布局 | Android 使用 adjustResize，键盘上移输入区而不把顶栏推出屏幕；Slash 菜单位于键盘之上。输入换行、用户展开和键盘改变视口是合理布局变化，不能靠固定聊天高度破坏适配。 | [Polish]、[I2]、[A6]、[Android Manifest][A16] |
| V09 | 稳定消息身份与行复用 | 更新不重置消息 key、会话或展开身份；只重算内容依赖变化的投影行，依赖包含工具结果配对和临时行合并，不用全量序列化、全局变化号或首个未变行提前结束判断。 | [ADR-0039][D39] §5、[D46]、[D49] |
| V10 | 乐观发送精确对账 | 写入通道后立即显示本地气泡 / 队列提交态并清空输入；以 Host 声明的消息对应关系替换权威行，保留稳定呈现身份，不能按正文、时间或数组下标猜匹配。发送中 / 核对 / 失败用气泡下方已有操作区，失败可重发、放回输入框或删除；结果未知不自动重发。 | [D49] §1–4、[iOS 待发送][I6]、[Android 待发送][A17] |
| V11 | 乐观关闭可恢复 | 关闭命令写入后先隐藏并退场；Host 拒绝、成功后 15 秒仍在线、60 秒无回执时恢复卡片并提示。断线清理本地关闭记录，重连以权威在线列表为准；不把退场当成进程已退出。 | [D49] 首页关闭规则、[I3]、[A6] |
| V12 | 不伪造有效配置与完成 | 停止仅显示处理中；模型 / 思考级别 / 权限、新建 / 恢复、Rewind / 分支等依赖源端确认，不能先显示已经生效。归档、队列撤回的乐观化在 D49 仍属后续建议，不能自动视为已交付。 | [D49] 其他操作评估、[ADR-0031][D31] |
| V13 | 缓存首帧与导航响应 | 一次打开只选择一次带 Host 身份的会话，当前选择和消息一致发布；缓存首次布局直接定位末尾，远端核对不阻塞导航。延后刷新核对 Host / Runtime / Session / 生命周期；Android 首页保持同一组合身份，绘制层更新转场，返回后立即能再次点击。 | [D48]、[A10]、[T1]、[进入测试][T3] |
| V14 | 首屏工作量与虚拟化 | 默认折叠的正文首次展开前构造 / 测量次数为零；长轮次分段懒加载，目录保留 LazyColumn；展开后保留状态。不能通过截断已加载正文、减少历史覆盖或固定等待来掩盖停顿。 | [D47]、[D48]、[I1]、[A4] |
| V15 | 绘制成本有界 | Android 柔影使用与控件尺寸无关的九宫格角块图集，材质键缓存上限 8；嵌套平铺不分配图集。字素动画复用有限画笔，不每帧生成整卡硬件模糊纹理；失败安全降级并保留诊断。 | [ADR-0042][D42]、[D46] §4、[A2]、[A9] |
| V16 | 短反馈生命周期 | 成功短反馈约 2.5 秒恢复，新操作 / 离开 / 断开时清理适用的旧反馈与计时；重复操作不得被旧计时清掉。错误保留明确详情和恢复入口，不用永久转圈或瞬时成功图标替代。 | [I1]、[iOS Store][I7]、[A6]、[D46] §3–4 |
| V17 | 草稿、选择与状态隔离 | 草稿按配对 / Host / Runtime / Session 归属保存；跨请求切换保留各自表单，敏感草稿只留内存。取消、搜索、换电脑、清单变化等按作用域清理选择；不能把旧回执、选择或恢复任务应用到新目标。 | [Parity]、[D30]、[I4]、[I5]、[A8]、[A15] |
| V18 | 自适应与降级保持正确 | 明暗、窄屏 / 大字体、窗口尺寸、减少动画和平台兼容路径均须保留文本、操作、展开状态和阅读语义；动画只表示呈现，不是同步 / 消息 / 操作完成证据。离线只读、加载中、失败、空、未知必须区分。 | [D46]、[D47]、[Parity]、[A7] |

### 6. 品牌、桌面端与网页：10 项

移动端的四档字号、圆角和触控参数不强制套到桌面或官网；以下按现有表面单独冻结。

| ID | Feature | 冻结规则 | 来源 / 实现入口 |
| --- | --- | --- | --- |
| X01 | Orbis 品牌母版 | 开口方环和右上小方块保持独立及既定间隙；各尺寸从同一母稿导出。商店素材不预制圆角，Android adaptive / monochrome 遵守安全区；macOS Dock 用深蓝圆角底板，窗口 / 菜单栏用透明符号。 | [品牌资源][Brand] |
| X02 | Agent 视觉身份 | Pi、Codex、DeepSeek、Claude 图标随包交付并保留来源许可；身份来自 runtime / session，不能根据模型供应商推断。底板不随 Agent 改色，聊天强调色跟随 Agent；通用设置 / 连接 / 下载不冒用 Agent 主题。Pi / Claude 图形保留原色。 | [Agent 标识][Icons]、[iOS 设计组件][I1]、[Android Agent][A18] |
| X03 | Host 桌面材质与控件 | macOS / Windows 共用 Qt Quick 页面，蓝灰 `#E6EBF4` 底板、双向柔影卡片、凹陷输入和按下态；按钮保留焦点、禁用、primary / danger 语义。共用 Card / ActionButton，不导入移动端另一套几何或网页 CSS。 | [Host 主界面][H1]、[Host 卡片][H2]、[Host 按钮][H3] |
| X04 | Host 阴影缓存 | Gaussian 柔影保持连续衰减、凹影裁切及左上光源；按尺寸、圆角、内外影、材质和模糊等属性变化刷新缓存，重复绘制复用，不重新制造轮廓色带。 | [Host 阴影][H4]、[Host 材质测试][HT1] |
| X05 | Host 控件动效 | 开关滑块约 160ms OutCubic；确定下载进度约 200ms 插值，未知总量只在适用时显示 1100ms 往返指示。动画表达当前事实，不伪造进度和安装完成。 | [H1] |
| X06 | Host 诊断画面有界 | 日志模型 / 待处理队列最多 300 行、每行最多 1600 字符、250ms 批量发布；固定高度虚拟列表、可选只读纯文本，用户在末尾才跟随。日志不重建整页 Host 状态，导出包含尚未刷新的缓存。 | [日志模型][H5]、[日志视图][H6]、[日志测试][HT2] |
| X07 | Relay 网页风格 | 公共站点 / 管理台使用现有蓝灰底板、凸起卡片、凹陷输入和共用 CSS token，保留品牌 / 产品预览及 Host / App 分开的下载卡与平台选择。官网展示稿不覆盖实际移动端消息规范。 | [Relay 站点决策][D15]、[Web 样式][W1]、[公共页面][W2]、[管理页面][W3] |
| X08 | Web 响应式与键盘可达 | 保留桌面 / 窄屏布局、320px 最小页面宽度、现有媒体查询、skip link 和 focus-visible。平台切换、页签、表单、表格和危险操作继续有可理解的焦点 / 状态语义。 | [W1]、[W2]、[W3]、[站点脚本][W4] |
| X09 | 官网导览与滚动动效 | 现有 feature tour 有手动页签 / 前后切换、播放暂停、约 6500ms 自动轮播；减少动画默认暂停。滚动场景按可见区域切换并同步 aria 状态；CSS 减少动画覆盖保留，缺少观察 API 时仍显示初始内容。 | [W1]、[W4] |
| X10 | Web 动态状态真实性 | 注册可用性、下载平台 / 包、大小与校验信息来自实际接口；加载失败、未发布和不可用明确呈现，不能用演示图或旧静态文字假称可下载 / 注册成功。管理台的操作结果来自 Relay 实际权限边界。 | [D15]、[W3]、[W4] |

### 7. 页面覆盖索引

下表只帮助定位，不新增 feature 计数；通用 S / M / V 规则仍适用于所有新页面。

| 页面 / 场景 | 优先查阅 |
| --- | --- |
| 配对、扫码、首次进入 | S01–S09、S12–S13、S16、V18、X01–X02 |
| 主页、电脑切换、在线会话卡 | S14–S19、M06–M12、V11、V13、V17 |
| 目录抽屉、搜索、归档 / 恢复、新建 | S14–S20、M03、M06、M09、M11–M12、V14、V17 |
| 聊天、只读缓存历史、Markdown | S01–S12、S16–S17、S20、M03–M05、M07–M08、V01–V06、V09–V10、V13–V18 |
| 输入、Slash、队列、模型 / 权限 | S12–S13、S17、M12、V03、V05–V08、V10、V12、V16–V18 |
| 审批、问卷、多请求切换 | S02–S08、S12–S13、M03、M12、V07–V08、V12、V17–V18 |
| 历史树、分支、Rewind、预览 | S10–S11、S20、M03、V01–V04、V09、V12、V17 |
| 文件浏览、上传、下载、工具详情 / 导出 | S09、S11、S14–S15、S20、M03、M05–M06、V09、V14–V18 |
| 设置、供应商、状态、错误详情 | S01–S09、S12–S16、S18–S19、M06、M12、V05、V12、V16–V18 |
| Host、Relay、品牌 | X01–X10；不要把移动端 token 无条件扩散到这些表面 |

## Verification

### 已有证据与回归入口

既有测试结果仍以原记录的日期、构建、配置和范围为准，不能累加测试数量或视为当前源码全部复测成功。

| 涉及 feature | 现有证据 / 定向回归入口 |
| --- | --- |
| S01–S20、M01–M06、V01–V08 | [移动端打磨验收][Polish]；Android `UiPolishInstrumentedTest`、`MarkdownInstrumentedTest`、`ComposerSessionInfoInstrumentedTest`、`ChatStatusLayoutInstrumentedTest`；iOS `testPageScreenshotsInBothAppearances`、`testRefreshKeepsHeaderTextAndTruncationStable` |
| V01–V04、V09 | Android `ChatViewportInstrumentedTest`、`HistoryPagingTest`、`ChatListItemReuseTest`；iOS 长末尾回复、移动阅读锚点与回到最新用例；[D39]、[D41]、[D46] |
| M03、V13–V14 | [D47]、[D48]；Android `DeferredDisclosureInstrumentedTest`、`ChatEntryInstrumentedTest`；iOS `testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState`、`testCachedOnlineChatEntryTiming` |
| M07–M11、S15、V11、V17 | [T1]、Android `HomeNavigationInstrumentedTest`、`HomeSwipeCloseInstrumentedTest`、`HomeSelectionInstrumentedTest`、`SessionArchiveSelectionInstrumentedTest`；iOS 返回、左滑、多选及目录收缩用例 |
| V07、V10–V12、V17 | [D49]、两端 PendingSend 单测、Android `OptimisticActionsInstrumentedTest`、`InteractionWorkspaceInstrumentedTest`；iOS `testOptimisticSendReconcilesAndRejectedSendRestores`、`testApprovalOverlayKeepsComposerStableWhileSubmitting` |
| V15、X04、X06 | [D42] 真机内存与像素对比记录；Android `NeumorphInstrumentedTest`；Host [HT1]、[HT2] |
| M12、X01–X03、X07–X10 | 以相关源码、资源说明和已有界面记录为盘点依据；触觉体感和网页 / 桌面完整视觉表现不能只凭源码检查宣称已验收 |

### 2026-10-30 / r2 会话卡片几何回归

- 涉及 S19、S08、S15、V18：iOS 标题采用 `lineLimit(2, reservesSpace: true)`，Android 采用 `minLines = 2 / maxLines = 2`，保持原有宽度、材质、状态槽与选择标记。
- 定向入口：iOS `testDrawerCardsKeepUniformGeometryForShortAndLongTitles`；Android `SessionDrawerLayoutInstrumentedTest`。iOS 在池内 iPhone SE（375pt、iOS 27.0）上 2 项 UI 回归通过，覆盖明暗、系统 XXXL 设置、长短标题和多选 / 归档 / 恢复；Android 在池内 API 35 上 2 项回归通过，覆盖 360dp 可用宽度、明暗及 1.0 / 1.5 字体缩放。两端截图已复核，详见 [会话卡片验收记录][Polish]。iOS 沿用现有固定文字 token，XXXL 不等于新增正文动态字体支持。

### 2026-10-30 / r6 压缩活动状态显示

- 涉及 S17、S19、V05、V12、V17–V18：两端使用 Host 已有的 `execution.compaction.phase`，在聊天顶栏、首页与目录现有状态槽显示“压缩中”；等待确认优先，压缩完成、失败、不可用或执行域未知时按权威 phase 恢复。状态只参与显示，不替代执行 phase，不插入消息或改变阅读锚点。
- 定向回归：Swift `AgentStateTests.compactionActivityDrivesPresentationWithoutChangingExecutionPhase`、Android `AgentModelConsumerTest` 的压缩状态用例；iOS `testCompactionStatusInHomeChatAndDrawer` 与 Android `ChatStatusLayoutInstrumentedTest.compactionUsesTheExistingStatusSlotInBothThemesAndLargeText`。两端 Debug / 测试包编译、96 项 Swift 核心与 25 项 Android 单测通过；池内 iPhone SE（375pt、iOS 27.0）的 1 项 UI 用例及 Android API 35 的 2 项 UI 用例通过。iOS 覆盖首页 / 聊天 / 目录的明暗显示与刷新稳定性，Android 覆盖明暗、220dp 状态行和 1.0 / 1.5 字体缩放；截图已复核。结果保留于 `.artifacts/compaction-status/compaction-ui.xcresult` 及同目录日志 / 截图；真实 Host / 真机未验收。

### 2026-10-30 / r7 Agent 图标配额翻面

- 涉及 S05–S06、S13、S19、M11、V17–V18、X02；两端共用 44pt/dp 图标外围环、12pt/sp 周期 / 百分比角标、64×56pt/dp 独立图标命中区。每次翻面在 180ms 到侧边时切换内容，再用 240ms 翻入，避免背面文字镜像；仅初次成功双窗口查询演示两次，其余刷新保持所选周期。
- iOS `testCompactQuotaCardsAndTransparentSwitch` 在池内 iPhone SE 上通过，覆盖明暗、图标首次查询、5h / 周手动翻面、整卡刷新保留周窗口、两 Agent 读数隔离与透明切换菜单；88pt 卡片高度与至少 48pt 图标命中区断言通过，浅深色截图已复核。结果为 `.artifacts/subscription-quota/compact-ui/ios-161426.xcresult`，附件位于同前缀 `-attachments/`。
- Android 编译与 4 项 `SubscriptionQuotaTest` 通过；`SubscriptionQuotaInstrumentedTest` 在池内 API 35 上通过，验证首次图标查询、双翻面回到 5h、手动翻面不发查询、整卡刷新、失败保留周窗口与读数、两 Agent 隔离、48dp 以上命中区及透明切换。明暗截图已复核，结果为 `android-161426-ui.log`，截图位于 `android-161426-screenshots/`。减少动画行为已实现，尚未单独完成设备验收；真实订阅账号未查询。

### 2026-10-30 / r10 左倾配额币与供应商平铺行

- iOS / Android 供应商行移除独立底板，仅保留外层卡片；Android 避免重复内距，窄屏标题先让出刷新图标的空间。配额币采用左倾 24° 斜轴、4° 轻倾、2pt/dp 抬起和 3.5% 放大，薄边偏移沿轴的垂直方向，角标与命中区保持固定。
- 两端编译、Android 4 项配额单测及 iOS / Android 各 1 项明暗 UI 回归通过。最终证据为 `.artifacts/subscription-quota/compact-ui/ios-172554.xcresult` 与 `android-171729-ui.log`；已检查两端截图与 Android 60 张实际中间帧，导出 `left-tilt-coin-light.gif` / `left-tilt-coin-dark.gif`。
- iOS 原系统菜单在 `ios-171159`、`ios-171525`、`ios-171951` 三轮发生可命中菜单项点击后不收起、未切换；改为复用 Orbis 共用菜单后，恢复普通 tap 并通过两种外观下的切换断言，失败记录保留。Android `171159` 的交互断言通过，但中间帧被 System UI 无响应弹窗遮挡，不用于视觉验收；复用同一池内设备冷启动后 `171729` 回归和画面检查通过，保留原干扰记录。

### 已知差异与未验收范围

- iOS 17 的滚动兼容分支有编译记录，原打磨验收没有该系统的运行结果；17 不启用字形模糊渐显。
- iOS 尚未达到 Android 的完整 CommonMark 覆盖、历史轮次树 / 嵌套分支预览能力。保留 [对齐记录][Parity] 的差距，不把登记为冻结基线等同于两端功能已完全相同。
- 多真实 Host、真机各 backend、实际文件 / 网络 / 审批场景及最终触觉体感，以对应专题的真实环境验收为准；模拟器夹具不替代这些结论。
- S13 登记的是共用触控规范；已有 iOS 局部图标 / 产物入口仍存在 44pt 路径，未在本次完成全量命中区验收。不能据此声称所有入口都已满足 48pt，也不在纯文档任务中批量改控件。
- 历史对齐 / 审计中的别名操作、旁置下载按钮、逐层阴影、展开全部、连接排序和旧消息形态仅说明当时实现。当前首页手势为关闭，下载按 S20，材质按 S02，目录按 S19；`1509f98` 的下载整卡操作覆盖 D46 / 打磨记录中较早的旁置方案。
- [D50] 的固定 LAN / Relay 与排序逻辑删除随本次集成进入 main；主线供应商入口已在连接状态页，故同步删除不再承载设置的页面和导航。原 worktree 验证见 D50；合并后的构建与回归单独记录，生产发布仍待执行。
- Android 下载卡摘要当前仍有 UI 自行拼接的中点分隔符，偏离 S16 / D46；本次登记差异，不把这处实现恢复为设计标准。配额图标翻面与连接状态页供应商层级已通过本轮两端模拟器回归；真实账号配额与真机触觉仍待验收。
- Android 入场接管和首页保留以 `ed8da5d` 后的 [A10] / [T1] 为准；D48 恢复入场时的旧测量不自动代表后续实现耗时。首帧、正文可见、动画完成、源端核对必须分开计时。
- 本次新增 ADR 只做盘点、引用与一致性检查，不运行构建、模拟器或真机测试，不新增“已验证安装包 / 性能提升”的结论。

## Maintenance

根目录 `AGENTS.md` 与 `CLAUDE.md` 必须包含关键词和本 ADR 引用；两者保持 Git 忽略，不能为维护规则而强制提交。

1. 设计或改动前，先查关键词、相关 feature ID 和源专题 ADR；将受影响 ID 写入本次设计 / 变更说明。
2. 新 feature 先复用现有 token、组件和状态边界。确需新增、修改、删除、替代或调整参数时，在同一任务中更新本 ADR 的规则、适用平台、来源、验证与修订记录；新增 ID 追加，旧 ID 不复用。
3. 同步更新两个本机指南的基线版本、关键词、引用和维护说明；即使关键词不变，基线版本也须对应最新修订。影响专题契约时同步修订原 ADR，明确覆盖哪条旧决策；影响审计 / 对齐记录时更新其当前状态说明，保留历史证据。
4. 根据实际影响执行有意义的回归：视觉改动核对相关页面的明暗 / 窄屏 / 大字体；动效检查起始、中间、结束、取消和减少动画；稳定性检查刷新、长文本、分页、拖动 / 惯性、键盘和失败恢复。纯文档变更检查编号、计数、相对链接和两个指南的一致性。
5. 如需设备或构建，遵循本机指南中的共享设备池、独占锁、固定构建目录及证据保留规则；旧文档的“专用模拟器”只指独占借用池内设备，不授权新建或绕过配额。
6. 记录实际通过、未运行、失败和待验收项；用户已收到的产物路径和未解决失败证据继续保留。完成前核对 ADR、专题文档、实现和两个指南是否描述同一基线。

### 修订记录

| 日期 / 版本 | 涉及 ID | 变更与验证 |
| --- | --- | --- |
| 2026-10-30 / r1 | S01–S20、M01–M12、V01–V18、X01–X10 | 首次归并 60 项冻结规则；补充后续转场 / 按压 / 触觉 / 乐观操作，登记平台差异；同步两份本机指南与文档入口。仅文档一致性检查，未重跑设备测试。 |
| 2026-10-30 / r2 | S19（关联 S08、S15、V18） | 会话标题统一预留两行，卡片等宽等高并保留现有字号策略；同步两端实现、定向几何回归和两个本机入口。iOS / Android 各 2 项设备回归通过，明暗 / 窄屏截图已复核。 |
| 2026-10-30 / r3 | S14、S19、V18、X02 | 记录连接状态页按 Agent 显示供应商、切换入口、官方图标与 Codex / Claude 双配额环；设置页移除供应商入口。已完成代码级验证，真实账号与设备视觉验收待后续运行。 |
| 2026-10-30 / r5 | S05、S13、S19、M11、V17、V18 | 配额环缩为 64pt/dp，移除圈下大标题和点击说明，用角标、刷新图标和请求 / 结果动效表达；切换按钮透明无底色，整卡查询与菜单独立。两端编译、Android 单元测试和 18 项 Swift Host 状态测试通过，原 64pt 双环 iOS 明暗 UI 回归通过，Android 当时受 ADB 环境阻塞；此视觉方案由 r7 替代。 |
| 2026-10-30 / r6 | S17、S19、V05、V12、V17–V18 | 聊天顶栏、首页与目录复用状态槽显示 Host 确认的“压缩中”，保留等待确认优先级、执行语义与状态隔离；同步两端实现和本机入口。两端编译、96 项 Swift / 25 项 Android 单测、iOS 1 项 / Android 2 项设备 UI 用例通过，明暗 / 窄屏截图已复核；真实 Host / 真机未验收。未新增 feature，仍为 60 项。 |
| 2026-10-30 / r7 | S05–S06、S13、S19、M11、V17–V18、X02 | 按用户思路将双环收为 Agent 图标外的单个 44pt/dp 环，周期与百分比改角标；图标翻面、整卡刷新、透明供应商切换分别响应。首次成功双翻面演示可被用户接管，减少动画直接切换。iOS / Android 明暗 UI 回归与截图复核通过，Android 编译和 4 项配额单测通过。 |
| 2026-10-30 / r9 | S02、S19、M11、V18、X02 | 配额币改为 30° 斜轴三维翻转、薄边与随角度变化的扫光；图标中心旋转并轻微抬起，角标留在原位淡化。角度连续走完 0° → 180°，侧面时切换内容，避免瞬时重置导致回摆；560ms 缓入落定，命中区固定。两端构建、Android 4 项配额单测与 iOS / Android 各 1 项明暗 UI 回归通过；Android 采集 60 张实际动画帧并复核斜轴、侧边厚度、扫光、角标位置和落定，已导出明暗 GIF。iOS 结果 `ios-165032.xcresult`，Android 结果 `android-165032-ui.log`，均位于 `.artifacts/subscription-quota/compact-ui/`。 |
| 2026-10-30 / r10 | S02、S19、M11、V18、X02 | 按用户要求将配额币斜轴改为左倾 24°，同步实体边方向，轻倾收为 4°、抬起 2pt/dp、放大 3.5%；保留 560ms 翻面与独立角标。供应商行移除独立白底，两端共用一张外层卡片，保留按压反馈与独立查询 / 翻面 / 切换；iOS 切换入口改为复用共用菜单层。两端构建、Android 4 项配额单测及两端明暗 UI 回归通过；60 张 Android 动画帧与两端明暗截图已复核。最终结果 `ios-172554.xcresult`、`android-171729-ui.log`；此前失败及系统弹窗干扰记录继续保留，见本轮验证说明。 |

| 2026-10-30 / r12 | S18–S19（关联 V17–V18） | 集成固定 LAN / Relay 选路，删除连接排序及其空设置页和入口；保留连接状态页供应商、配额币与既有动效。合并后的代码与文档验证单独记录，不继承其他变更的设备验收结论。仍为 60 项。 |

## Consequences

新 UI 工作有统一检索入口和稳定的 feature 编号，既有风格、动效和阅读体验默认保持。
代价是基线演进时要同步决策、实现、证据和两个本机入口；这使后续模型能够区分当前规则、旧方案与尚未验证的能力。

[D15]: 0015-relay-website-and-operator-console.md
[D30]: 0030-multi-host-mobile-connections.md
[D31]: 0031-host-permission-management.md
[D39]: 0039-content-change-signals.md
[D41]: 0041-history-paging-edge-trigger.md
[D42]: 0042-bounded-shadow-bitmaps.md
[D45]: 0045-tool-summaries-and-on-demand-content.md
[D46]: 0046-mobile-ui-stability-and-material.md
[D47]: 0047-deferred-chat-disclosure-content.md
[D48]: 0048-online-chat-entry-budget.md
[D49]: 0049-optimistic-send-and-source-reconciliation.md
[D50]: 0050-fixed-lan-relay-routing.md
[Polish]: ../testing/mobile-ui-polish.md
[Audit]: ../../android/docs/neumorphism-audit.md
[Parity]: ../../ios/Orbis/docs/android-ui-parity.md
[Brand]: ../../branding/orbis/README.md
[Icons]: ../../android/docs/agent-icons.md
[I1]: ../../ios/Orbis/Orbis/OrbisDesign.swift
[I2]: ../../ios/Orbis/Orbis/ChatView.swift
[I3]: ../../ios/Orbis/Orbis/ContentView.swift
[I4]: ../../ios/Orbis/Orbis/SessionViews.swift
[I5]: ../../ios/Orbis/Orbis/InteractionView.swift
[I6]: ../../ios/Orbis/Orbis/PendingSends.swift
[I7]: ../../ios/Orbis/Orbis/OrbisStore.swift
[I8]: ../../ios/Orbis/Orbis/DownloadView.swift
[A1]: ../../android/app/src/main/java/com/orbising/orbis/OrbisTheme.kt
[A2]: ../../android/app/src/main/java/com/orbising/orbis/Neumorph.kt
[A3]: ../../android/app/src/main/java/com/orbising/orbis/RemoteUi.kt
[A4]: ../../android/app/src/main/java/com/orbising/orbis/UiPolish.kt
[A5]: ../../android/app/src/main/java/com/orbising/orbis/MarkdownText.kt
[A6]: ../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt
[A7]: ../../android/app/src/main/java/com/orbising/orbis/ComposerSessionInfo.kt
[A8]: ../../android/app/src/main/java/com/orbising/orbis/SessionDrawer.kt
[A9]: ../../android/app/src/main/java/com/orbising/orbis/StreamingText.kt
[A10]: ../../android/app/src/main/java/com/orbising/orbis/SwipeBack.kt
[A11]: ../../android/app/src/main/java/com/orbising/orbis/HomeSwipeClose.kt
[A12]: ../../android/app/src/main/java/com/orbising/orbis/NavigationPress.kt
[A13]: ../../android/app/src/main/java/com/orbising/orbis/ActionHaptics.kt
[A14]: ../../android/app/src/main/java/com/orbising/orbis/HistoryPaging.kt
[A15]: ../../android/app/src/main/java/com/orbising/orbis/InteractionWorkspace.kt
[A16]: ../../android/app/src/main/AndroidManifest.xml
[A17]: ../../android/app/src/main/java/com/orbising/orbis/PendingSends.kt
[A18]: ../../android/app/src/main/java/com/orbising/orbis/AgentBrand.kt
[I9]: ../../ios/Orbis/Orbis/StatusViews.swift
[A19]: ../../android/app/src/main/java/com/orbising/orbis/MainActivity.kt
[T1]: ../../android/app/src/androidTest/java/com/orbising/orbis/SwipeBackInstrumentedTest.kt
[T2]: ../../android/app/src/androidTest/java/com/orbising/orbis/ChatStatusLayoutInstrumentedTest.kt
[T3]: ../../android/app/src/androidTest/java/com/orbising/orbis/ChatEntryInstrumentedTest.kt
[H1]: ../../packages/windows-host/src/qml/Main.qml
[H2]: ../../packages/windows-host/src/qml/Card.qml
[H3]: ../../packages/windows-host/src/qml/ActionButton.qml
[H4]: ../../packages/windows-host/src/NeuSurface.cpp
[H5]: ../../packages/windows-host/src/DiagnosticLogModel.cpp
[H6]: ../../packages/windows-host/src/qml/DiagnosticLogView.qml
[HT1]: ../../packages/windows-host/src/tests/NeuSurfaceTest.cpp
[HT2]: ../../packages/windows-host/src/tests/DiagnosticLogTest.cpp
[W1]: ../../packages/relay/src/web/styles.css
[W2]: ../../packages/relay/src/web/index.html
[W3]: ../../packages/relay/src/web/admin.html
[W4]: ../../packages/relay/src/web/site.js
