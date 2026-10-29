# ADR-0047：聊天折叠正文延迟到首次展开时构建

日期：2026-10-29

Status: accepted（先记录决策再实施；两端实现及隔离模拟器回归已完成，真机端到端耗时待复测）

关联：[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0039](0039-content-change-signals.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)

## Context

用户反馈 iOS、Android 打开会话均有约 1–2 秒延迟。该时间是用户观察，尚无本轮真机 trace，
不能据此认定网络、Host 或单一 UI 组件占用了全部延迟。
用户随后确认：已在线的会话，退出再进入也卡。因此本轮优先处理每次进入页面都会重复发生的 UI 工作，
没有把历史会话激活、后端进程启动当成已证实的原因。

代码检查确认两端存在相同的首屏额外工作：

- iOS `OrbisDesign.swift` 的 `OrbisCollapse` 在初始化时执行 content builder，闭合时仍将完整
  子视图放进视图树，使用 `fixedSize` 测自然高度，再以零高 frame / opacity 隐藏。
  `ChatView.swift` 的 `CompactDisclosure` 还提前保存已经构造的 Content。
- Android `UiPolish.kt` 的 `OrbisCollapse` 无条件组合 content，并在 Layout 中测量所有子节点；
  闭合仅将外框高度乘以 0。聊天的 thinking 和工具详情都使用此组件。
- 因此“默认折叠”没有避开长思考正文、旧工具参数和输出的首次构造、文本排版与测量。
  聊天列表按助手轮次分组，一条可见轮次会带入其中全部折叠组件，外层 Lazy 列表不能消除这些工作。
- 两端已有 30 条首屏历史页和后台本地缓存读取；iOS `seedCachedHistory` 与 Android
  `launchFirstSessionPage` 不要求先等远端确认才显示本地记录。本轮不凭用户感知时间修改同步契约。

ADR-0046 §4 要求折叠先测量完整内容、动画中保留自然布局与内部状态，但没有限定测量的时机。
本决定补充为“用户首次展开时测量”，避免所有关闭的详情在打开会话时一起排版。

## Decision

1. 两端共享折叠组件在首次展开之前不执行正文 builder、不挂载正文、不测量正文。
   标题、状态、点击目标正常展示；首次即 expanded 的调用仍立即展示内容。
2. 第一次展开时挂载并测量正文，再执行现有高度裁切动画。之后保留该组件的内容身份，
   收起和再次展开继续保留内部状态。快速切换、正文更新和系统关闭动画均保持正确。
3. iOS 的通用折叠组件及聊天 disclosure 均保存延迟执行的 builder，不能只在最内层隐藏
   一个已经被上游 builder 构造完的正文。Android 将动画值的读取留在测量阶段。
4. 不增加打开会话的固定等待、不截断消息、不减少实际历史覆盖、不修改 source / applied
   baseline、缓存归属、Host 原生核对或同步超时。详情首次展开的工作发生在用户请求它的时候。
5. 性能证据分成结构性成本与端到端耗时。自动回归确认闭合状态的正文构造和测量次数为零，
   并检查首次展开、收起后再展开的状态与内容。只有实际测量才能宣称打开会话从多少毫秒降到多少毫秒。

## Verification

- 使用隔离 UI 夹具，包含多条折叠详情和长文本，验证首次闭合不构造 / 测量正文。
- 展开后正文完整可见；正文更新可见；收起 / 再展开保留内部状态；快速反转不遗留错误高度。
- 两端相关核心测试及原生编译检查通过；执行环境不能提供的设备验证须明确记录。
- 真机后续按相同会话区分点击到首帧、首批消息可见和源端确认；分别测冷缓存、热缓存、
  短消息与长 thinking / 工具轮次。页面转场与源端同步分别记时，不把同步完成当成首帧。

## Consequences

未展开过的详情不再增加聊天首屏的正文排版成本。首次展开仍须支付其实际构造和测量成本；
已展开过的内容继续保留以满足 ADR-0046 的状态约束。本决定解决一个已确认的跨平台热点，
不代表用户报告的全部 1–2 秒延迟已经被定位或消除。

## 实施与验证记录

- iOS `OrbisCollapse` 和 `CompactDisclosure` 保存延迟 builder；Android `OrbisCollapse`
  在首次展开前不创建 Layout 子内容，并在测量阶段读取动画值。首次展开后保留子树，
  iOS 用 token 忽略被后续切换替代的异步动画启动。
- 两端隔离夹具各含 30 个详情，每个正文 300 行；连续重建页面 3 次，未展开正文的 builder
  与布局计数均为 **0**。展开后计数大于 0，关闭后更新正文、再展开保留 `Count 1` 的内部状态，
  并显示更新后的正文。这些计数证明工作被延后，不是端到端耗时或帧率的替代指标。
- iOS：177 项核心测试通过；模拟器原生构建及应用包动态依赖检查通过；专用 iPhone 17e / iOS 27.0
  模拟器上的 3 项 UI 测试通过，覆盖上述计数、长会话重入及展开时阅读位置、工具详情分页。
- Android：479 项单元测试通过，Debug / AndroidTest APK 构建通过；专用 API 35 模拟器上的
  6 项设备用例通过，覆盖计数与内部状态、初始展开及动画反转、4 项聊天滚动 / 内容更新回归。
  ADB 客户端在后半段断开；设备端 TestRunner 完整记录 `6 tests, 0 failed, 0 ignored`，
  不能仅凭截断的客户端输出判断结果。
- 为完成当前工作区构建，顺带修正了已有界面改动中的 SwiftUI frame 参数组合、HomeView
  的 reduce-motion 环境读取及 Compose offset / consume 导入；未重写已有会话命名与滑动交互改动。
- 本机证据位于 `.artifacts/chat-open-perf/`：`swift.log`、`android-build.log`、
  `android-ui-device.log`、`ios-ui.log`、`disclosure-final.xcresult`。未操作用户真机或生产 Host。

可复用回归入口：

- Android：`DeferredDisclosureInstrumentedTest`、`ChatViewportInstrumentedTest`。
- iOS：`testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState`、
  `testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging`、`testToolDetailsLoadPagesAndClose`。
  `--preview-screen=disclosure` 仅 Debug 提供计数夹具；Release 不含该入口或夹具。

待真机复测：相同在线会话反复进入的点击到首帧 / 首批正文耗时，以及剩余停顿的主线程与网络 trace。
本轮没有给出未经测量的“减少多少毫秒 / 提升多少百分比”，也没有将运行测试所需时间解释为打开会话耗时。
