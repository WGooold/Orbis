# ADR-0051：UI 风格、动效与画面稳定性基线

日期：2026-10-30；Status: accepted。当前基线：`2026-11-05/r48`。

保留共用材质、原生文本、稳定消息身份、阅读位置及平台手势。基线按需求演进，性能优化保持既有可见行为，新增 feature 使用新编号。

当前修订：消息旁菜单与显式选字；iOS 侧栏沿用 r47、Android 恢复原材质；回复卡片、语言、后台任务与统一轻压均维持现有实现。参数、生命周期和边界以实现及测试断言为准。

登记 90 项（S 33、M 24、V 22、X 11）；历史登记已交付 67 项，不代表本次重验或后续修订已验收。未完成的用户 / 设备验证继续待验证；实际状态只认本次证据。

| ID | 作用 |
| --- | --- |
| S01 | 明暗四层底板 |
| S02 | 单一材质外框 |
| S03 | 同心圆角 |
| S04 | 柔影与带色遮罩 |
| S05 | 四档界面字号 |
| S06 | 等宽数字 |
| S07 | 图标光学校正 |
| S08 | 原生文字语义与断行 |
| S09 | 扩展名与完整文件名 |
| S10 | 用户 / 助手消息形态 |
| S11 | Markdown 阅读层次 |
| S12 | 柔和输入焦点 |
| S13 | 可见几何与触控区 |
| S14 | 卡片旁小操作 |
| S15 | 批量选择视觉 |
| S16 | 简洁文案 |
| S17 | 聊天顶栏与输入结构 |
| S18 | 当前电脑与连接显示 |
| S19 | 目录与设置层次 |
| S20 | 新建、工具与文件入口 |
| S21 | 轮末文件审阅 |
| S22 | 设置页与唯一配对入口（r16 已实施，UI-04） |
| S23 | 设置页连接延迟（r25，UI-07；完整门禁未完成） |
| S24 | 最近提问提示（r29，完整门禁未完成） |
| S25 | 可切换的雾蓝外观（r34，验证中） |
| S26 | 主会话后台子任务（r44 已实施 / 验证中） |
| S27 | 全 App 中英文与跟随手机语言（r45，验证中） |
| S28 | 设置页显示当前连接协议 WS / QUIC（SC48，已实现，待用户验证） |
| S29 | 设置页 per-Host Relay 协议模式 auto / ws / quic（SC49，已实现，待用户验证） |
| S30 | 目录整体凸起外框与展开列表共用凹槽（局部替换，验证中；待用户验证） |
| S31 | 各后端共用内容步骤分卡与折叠工具组（[ADR-0066](0066-unified-chat-card-presentation.md) / SC50；已实现，定向自动验证通过，待用户验证） |
| S32 | Android 首页聊天 / 供应商 / 设置根导航、Agent 横拨与供应商屏外圆心弧盘（SC51；首版 7 项单元与 17 项设备验证通过、已保留数据升级；供应商页按 PD03 / PD04 视觉稿复刻中，其余页面冻结，待用户验证） |
| S33 | Host 跨 Agent 统一子代理库存与 App 精简状态提示（SC52；已实现，验证与边界见 [ADR-0068](0068-unified-subagent-inventory-and-app-hints.md)；未部署，待用户验证） |
| M01 | 自定义拖拽回位 |
| M02 | 勾选小反馈 |
| M03 | 自然高度折叠 |
| M04 | 流式新增字形渐显 |
| M05 | 复制反馈恢复 |
| M06 | 选择模式淡入 |
| M07 | 聊天入场 |
| M08 | 交互式右滑返回 |
| M09 | 目录抽屉跟手与收缩 |
| M10 | 首页左滑关闭 |
| M11 | 即时按压反馈 |
| M12 | 选择性触觉 |
| M13 | 文件切换跟手与落位 |
| M14 | 所有下一级整页统一滑入与右滑返回（r24 扩展，UI-04） |
| M15 | 首页下拉刷新（iOS r33 一次原生回位；Android r16 已实施，r21 调整列表位移，r22 修复回弹生命周期，r23 调整旋转与回位曲线） |
| M16 | 下载飞入下载按钮（r16 已实施，r18 两端设备验收，UI-06） |
| M17 | 输入消息飞入并展开（r36 验证中） |
| M18 | 锚点菜单与菜单栈（r31 验证中） |
| M19 | 用户消息菜单与显式文字选择（r48 验证中） |
| M20 | 全部图标按压反馈（r43 验证中） |
| M21 | 离散文字连续切换（r35 已接入，验证中） |
| M22 | 筛选集合连续过渡（r35 已接入，验证中） |
| M23 | 新建卡片与启动页交接（r35 已接入，验证中） |
| M24 | 实时回复卡片增高与首次出现（r46 已接入，验证中） |
| V01 | 像素距离跟随 |
| V02 | 阅读锚点锁定 |
| V03 | 更新保持阅读位置 |
| V04 | 分页边沿与显式加载 |
| V05 | 刷新顶栏固定槽 |
| V06 | 通知与短反馈覆盖 |
| V07 | 审批面板与草稿 |
| V08 | 键盘、安全区与正常布局 |
| V09 | 稳定消息身份与行复用 |
| V10 | 乐观发送精确对账 |
| V11 | 乐观关闭可恢复 |
| V12 | 配置与完成依据真实确认 |
| V13 | 缓存首帧与导航响应 |
| V14 | 首屏工作量与虚拟化 |
| V15 | 绘制成本有界 |
| V16 | 短反馈生命周期 |
| V17 | 草稿、选择与状态隔离 |
| V18 | 自适应与降级保持正确 |
| V19 | 轮次版本与按需读取隔离 |
| V20 | 运行中工具呈现连续（Android Pi 路径 r17 已修复；Android Codex r19 真实输出通过；iOS 按显示行增量合并、不做截断重建（代码核对）；**iOS 与 Claude 真实输出待验证**，UI-02） |
| V21 | 首页 / 目录列表视口稳定（Android 首页 r16 已实施；iOS 首页 r18 验证上方移除场景无此问题；r19 两端目录与首页自动用例定向通过，**全量与手动回归待完成**，UI-03） |
| V22 | 其他乐观操作可恢复（r27 新增，**r32 已实施、验证中**，未验收） |
| X01 | Orbis 品牌母版（瓷白雾蓝 B 版；底色直接调深至 #617FA3，资源已更新；安装效果待用户验证；见[品牌资源](../../branding/orbis/README.md)和[本次校验证据](../../.artifacts/2026-11-08-icon-background/checks.json)） |
| X02 | Agent 视觉身份 |
| X03 | Host 桌面材质与控件 |
| X04 | Host 阴影缓存 |
| X05 | Host 控件动效 |
| X06 | Host 诊断画面有界 |
| X07 | Relay 网页风格 |
| X08 | Web 响应式与键盘可达 |
| X09 | 官网导览与滚动动效 |
| X10 | Web 动态状态真实性 |
| X11 | Relay 单设备流量与带宽（已实现，自动验证通过；浏览器实看、部署与用户验收待完成） |

决策入口：[材质、阅读、设置与外观](0046-mobile-ui-stability-and-material.md)；[首帧与延迟构建](0048-online-chat-entry-budget.md)；[整页导航](0054-shared-full-page-navigation.md)；[共用交互、刷新与下载反馈](0058-shared-interaction-motion.md)。UI-01–UI-06、S / M / V / X 及场景原标识保持，新场景使用新标识。

视觉核对依据已确认来源的安装包与受影响行为，验证和验收分别保留对应证据；选测遵循 [根部规则](../../AGENTS.md#测试)。

2026-11-07 S18 / SC53 / MOT-28：首页后台同步改由新拟物凸起状态点轻微呼吸表示，连接文字与胶囊尺寸保持稳定；正常状态常亮。实现与验证入口见 [ADR-0058](0058-shared-interaction-motion.md)，[执行证据](../../.artifacts/ui-regression/20261107-home-raised-sync-dot/)；安装与用户验收待完成。

代码与证据：[Android 单元测试](../../android/app/src/test/java/com/orbising/orbis/) / [设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/)；[iOS 核心测试](../../ios/Orbis/Tests/) / [UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)；[Host / 协议测试](../../packages/)；[原始证据](../../.artifacts/ui-regression/)。

2026-11-05 PERF-07：Android 目录后台投影、行事实复用、标题缓存与 IO 水合保持 S19 / V21 及原视觉、动效、阅读行为；沿用 SC03 / SC08 / SC36、MOT-14，见 [ADR-0060](0060-mobile-relay-history-performance.md)。自动证据与用户验收分别记录，真机体感待用户验证。

2026-11-06 S30：目录头与展开内容共用凸起外框，展开列表内使用一个连续凹槽，保留排序、筛选、多选和逐行加载；Android 会话与目录列表均默认预览三条，目录列表可显式展开；目录标题固定两行、文件夹图标加凹陷底座；底部使用“查看全部 N 条”与完整路径，工作目录行两端对齐、主机底栏改为图标与名称/状态两行，卡片总左右边距收窄至 16dp，外框和凹槽按实际动画高度统一绘制。实现见 `SessionViews.swift` 的 `directoryGroup`、`SessionDrawer.kt` 的 `DrawerDirectorySlice` / `DrawerBranch`；Android 在列表背景中复用柔影缓存，按 lazy item 的实际高度统一绘制外框和凹槽，避免底部圆角切换；目录头点击不切换材质底色，展开期间不叠加列表位置动画。Android 最新定向设备测试 7 项通过（明暗、字体、长列表、多选及目录/会话重排视口；[结果](../../.artifacts/ui-regression/20261106-native-directory-tray/sidebar-content-results/instrumentation.log)），重排时以未移动的可见内容保留位置并排除间隔项；最新实机覆盖安装与启动[成功](../../.artifacts/ui-regression/20261106-native-directory-tray/sidebar-content-phone/install-result.json)。iOS 编译通过；后续设备与交付状态见[本次证据](../../.artifacts/ui-regression/20261106-native-directory-tray/)。Android arm64 Release 优化包已按现装签名覆盖安装 Redmi K70 Ultra，应用数据保留；构建产物带 testOnly 标记，安装使用 `adb install -r -t`。iOS 运行测试受其他任务保留的共享构建租约影响，未完成，iPad 未连接。用户验收待完成。

2026-11-06 S30 材质对齐：Android 侧栏使用局部灰绿浅色 / 石墨深色配色，搜索、目录外框和会话凹槽共用底色，由成对柔影表达凹凸；高光与暗影透明度随材质传入，高斯与低版本回退共用强度，目录凹槽扩大明暗过渡范围。其他页面和 agent 品牌色保持原样。实现：[DrawerMaterial](../../android/app/src/main/java/com/orbising/orbis/DrawerMaterial.kt)、[柔影](../../android/app/src/main/java/com/orbising/orbis/Neumorph.kt)；[明暗、字体、多选与长列表设备回归 4 项通过](../../.artifacts/ui-regression/20261106-sidebar-material/material-final-results/instrumentation.log)，后台目录投影测试等待发布后保留原断言，首次失败证据仍保留。arm64 Release 按现装签名[覆盖安装成功，保留数据](../../.artifacts/ui-regression/20261106-sidebar-material/material-phone/install-result.json)；[实机截图](../../.artifacts/ui-regression/20261106-sidebar-material/material-phone-check/navigation.png)确认灰绿材质已生效，暗色仅在模拟器验证。最终实机观感待用户验证。

2026-11-07 S30 高光修正：局部材质的浅色高光改为接近灰绿底色的低强度色，明暗高光分别降低透明度，并独立扩大高斯模糊半径；暗影与几何保持不变。柔影图集按最大模糊范围留边并纳入缓存键，短目录卡保留高斯路径，避免切回较窄的环近似；搜索和目录凹槽同步采用同一高光。新增[高光对照测试](../../android/app/src/androidTest/java/com/orbising/orbis/NeumorphHighlightInstrumentedTest.kt)，与既有明暗、字体、多选及长列表用例共 [6 项通过](../../.artifacts/ui-regression/20261107-sidebar-highlight/results/instrumentation.log)。交付副本保留现装首页源码，仅安装侧栏修正；arm64 Release [覆盖安装成功、保留数据](../../.artifacts/ui-regression/20261107-sidebar-highlight/phone/install-result.json)，[实机修正前](../../.artifacts/ui-regression/20261107-sidebar-highlight/phone-before/drawer.png) / [修正后](../../.artifacts/ui-regression/20261107-sidebar-highlight/phone/drawer.png)。深色仅在模拟器验证；最终观感待用户验收。

2026-11-06 S31 / SC50：聊天卡片统一按可见的思考、正文、工具步骤组织；工具之后的新正文或思考开始下一张卡，原生轮次只用于执行与计时。正文预算按内容块计算，多工具默认合为折叠组并分页展开，消息打包和后端类型不决定外框数量。源消息拆为本地显示片段时仅末片段持有计时与文件变更锚点；已显示边界在历史前插时保持。未改变协议、历史存储或发送语义。实现：[Android 分组](../../android/app/src/main/java/com/orbising/orbis/MessagePresentation.kt)、[iOS 分组](../../ios/Orbis/Orbis/Presentation.swift)、两端聊天视图。共用输入：[夹具](../../ios/Orbis/Tests/Fixtures/chat-card-layout.json)；回归：[Android](../../android/app/src/test/java/com/orbising/orbis/UnifiedChatCardTest.kt)、[iOS](../../ios/Orbis/Tests/UnifiedChatCardTests.swift)。执行、构建与清理证据：[本次证据](../../.artifacts/unified-chat-cards-20261106/)。安装、真实后端视觉回归及用户验收待完成。

S31 自动验证：提交范围在独立副本中复验，Android 定向单元测试 22 项、Swift 展示与统一卡片测试 29 项通过；iOS 通用模拟器目标完整编译通过，1485 项中英文目录及静态差异检查通过。Android 复用原生源码哈希一致的既有 QUIC 依赖包。原断言、首次失败及依赖准备日志保留在任务证据中，测试说明与预期按新展示语义调整。未运行设备视觉测试、未安装或部署；手动验证使用包含 S31 的新 App，在 Pi、DSH、Claude、Codex 会话查看连续调用、展开工具组、刷新及重连，状态为待用户验证。
