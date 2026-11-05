# ADR-0048：在线会话进入路径与首帧工作预算

日期：2026-10-30

Status: accepted（先记录决策，再测量和实施；两端实现及隔离模拟器回归完成，真机待复测）

关联：[ADR-0026](0026-host-selected-session-sync.md)、[ADR-0039](0039-content-change-signals.md)、[ADR-0046](0046-mobile-ui-stability-and-material.md)

## Context

闭合详情延迟构建后仍存在进入延迟的观察：点击已在线会话，包括退出后再次进入，需要等约 1–2 秒。
闭合详情延迟构建的回归不能替代进入页面的端到端测量。本轮分别检查点击回调、页面首帧和首批正文，
不把远端同步完成时间混入首帧指标。

代码检查已经确认：

- iOS 首页卡片先调用带 Host 的 `selectRuntime`，随后 `ContentView.openRuntime` 再选一次。
  每次选择都整理消息、订阅 Agent state、强制核对 Session 和刷新 Git 信息。
- Android 在发布选择前刷新 Agent state；选择回调还持久化当前位置、检查历史链，
  `SwipeBackLayer` 入场时同时组合整个首页底层和聊天页。聊天列表初始位于第一项，
  再由副作用跳到末尾，可能先排版完全不会展示的历史。
- 两端按整个助手轮次组织懒加载行；很长的轮次及 Markdown 的实际构造/布局成本仍需测量，
  不能把上述代码现象直接解释成观察到的全部延迟。

## Decision

页面首帧按可见范围安排工作，选择、消息和导航一致发布，来源核对在正确生命周期中调度。折叠内容按需构建，长列表复用稳定身份与原生虚拟化，过渡沿用共用交互契约。性能结论按点击、首帧与正文可见阶段分别测量。

实现入口：[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)、[UiPolish.kt](../../android/app/src/main/java/com/orbising/orbis/UiPolish.kt)。

参考：[OrbisDesign.swift](../../ios/Orbis/Orbis/OrbisDesign.swift)；[UiPolish.kt](../../android/app/src/main/java/com/orbising/orbis/UiPolish.kt)。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## Consequences

会话导航具有独立的响应预算，不再由网络核对或无关首页重建决定何时显示页面。
首批正文的实际布局仍然需要执行；若测量显示长轮次仍超出预算，应继续按可见范围减少工作，
并记录尚未验证的边界，不能仅凭编译和功能测试宣称已消除 1–2 秒停顿。

## 测量后补充决策（实施前）

- iOS 独立模拟器夹具含 80 对历史消息和 80 条同轮助手消息。修改产品路径前，
  三次进入的点击回调为 7.1 / 5.5 / 3.7 ms，首次绘制为 1970.5 / 582.6 / 355.5 ms。
  首次绘制是应用 UIView draw 回调，不是显示器实际呈现，也不包含点击手势识别前的时间。
  该证据将本轮重点收敛到长轮次布局。嵌套懒布局试验破坏首次末尾定位，故不采用。
  两端改在外层懒列表将超过 4 条消息的助手轮次拆为连续卡片段，每段最多 4 条消息；
  保留原消息顺序/身份、完整正文、工具关联及计时归属，复制回复仍复制整轮。
  短轮次外观不变，长轮次出现连续卡片边界。这是为了真实虚拟化的明确呈现取舍。
  单条超长 Markdown 的排版仍有成本，不声称按消息分段能解决所有文本尺寸。
- Android 历史覆盖检查在显示窗口之前的每个节点上重新遍历祖先链，形成二次复杂度；
  用一次祖先集合计算替代逐节点遍历，保留分叉、缺口、循环防护和窗口边界的语义。

## 首轮实施结果（入场动效取舍已被下方修订替代）

- 两端外层聊天懒列表对长助手轮次分段，每段至多 4 条消息；复制动作持有整轮内容，
  工具结果和计时仍归属对应消息。历史补入时复用已有分段起点，避免阅读锚点因重新分组消失。
  单条超长消息仍使用现有渲染，没有截断正文。
- iOS 首页通过一个含 Host 的回调完成选择，删除第二次选择。Git 首次刷新由 ChatView
  现有任务负责，不在选择回调中再发一次。本轮没有引入额外的异步选择状态机。
- Android 聊天直接从缓存末尾首次布局；进入时立即显示页面，不组合首页底层。
  首页仍在真实返回拖拽时出现，松手后的回弹/返回动效及首页保存状态保持原有契约。
- Android 历史覆盖检查只遍历两条链（当前历史、显示窗口祖先），查集判断覆盖。
  状态写入调用带上一份已核对状态；历史和图的对象身份未变时，选择及无关状态更新跳过覆盖重算。

## 最终验证与证据

[根部测试约束](../../AGENTS.md#测试)；[Tests](../../ios/Orbis/Tests)；[orbis](../../android/app/src/test/java/com/orbising/orbis)；[src](../../packages/host/src)。

## 2026-10-30 基线归并：入场接管与首页身份

[ADR-0051](0051-ui-style-motion-and-visual-stability-freeze.md) 的 M07、M08、V13 收录 `ed8da5d` 后已经落地的行为，
补充并替代上方修订中的“入场期间禁用返回拖拽”和“入场结束后释放首页底层”两条描述：

- Android 入场允许被右滑立即接管；按住时停止入场，继续移动时页面跟手，不以源端加载完成为前置条件。
- 首页保留同一组合身份，聊天遮盖期间不逐帧重组；返回完成后立即恢复交互，不留下屏外透明聊天层挡住点击。
- 取消返回保留弹簧回弹，确认返回使用 180ms 退场。位移、底层压缩和遮罩仍在绘制层更新，既有入场不删除。
- 对应回归入口为 `SwipeBackInstrumentedTest`（含 `rightSwipeInterruptsEntranceBeforeLoadingFinishes`）
  和 `HomeNavigationInstrumentedTest`。这是本次对既有实现 / 测试的盘点，不是本次重新运行设备测试；
  上方旧耗时与首页释放结果不用于证明后续实现的性能或生命周期。

## 2026-11-03 / r40：iOS 返回响应边界

补充现象：iOS 返回列表后短时间不能点击。原本的首帧探针从点击回调开始，无法发现点击之前被退场层挡住的时间；新增应用内松手→路径提交测量。确认返回改为共用 180ms 退场，取消保留原弹簧；不等待屏外弹簧移除才交回来源。规则与全部整页覆盖见 [ADR-0054](0054-shared-full-page-navigation.md) / [ADR-0058](0058-shared-interaction-motion.md) r40；不重用上文历史首帧数字作为本轮结论。证据与未完成门禁见 `.artifacts/ui-regression/20261103-ios-return-response/`。

2026-11-03 r40 返回响应验证：代码已实施，应用内实测与最终专项支持返回交接修复；完整iOS全量受外接盘中断和共享设备残留锁阻塞，Android深色按压反馈及其他全量失败保留，完整人工/最终动效帧未验收。结果与未跑范围见 [测试规则](../../AGENTS.md#测试) 和 `.artifacts/ui-regression/20261103-ios-return-response/summary.md`。
