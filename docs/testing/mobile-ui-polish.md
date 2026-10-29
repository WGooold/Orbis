# 移动端 UI 打磨验收

日期：2026-10-29。决策：[ADR-0046](../adr/0046-mobile-ui-stability-and-material.md)。

工作树：`ui-polish`，基于 `af694af`。接手时已有 10 个 iOS 文件的未提交改动；本轮补齐 Android，并完成 iOS 回归。

## 原要求与实现

| 要求 | iOS | Android |
| --- | --- | --- |
| 1. 一行内跟随、手动滚动停跟随、三行外回到最新 | 原生滚动几何 / phase；17 使用 pan 与减速观察 | 像素距离、拖动状态、UserInput；删除按列表项推断和发送后追新 |
| 2. 边框只一层 | 环境传递表面层级，嵌套平铺 | CompositionLocal 传递，弹窗 / 菜单重新建立独立表面 |
| 3. 同心圆角 | 父圆角减内容 padding | `contentPadding` / `contentInset`，圆形控件保留几何 |
| 4. 更新不引起意外位移 | 状态 / 同步 / 操作反馈保留槽；阅读锚点不因新增内容移动 | 固定聊天状态槽、配对反馈槽、待确认槽；复制图标同尺寸替换 |
| 5. 扩展名保留 | 文件浏览、下载、附件与产物分开主名 / 扩展名 | 同上；另有长扩展名、复合扩展名和点文件测试 |
| 6. 四层微明度、禁纯黑应用边框 / 遮罩 | 明暗四层 token | 同源 token，主题默认文字色也随明暗变化 |
| 7. 柔和聚焦双环 | 加深凹槽和强调色光环 | 共用输入组件；搜索、问卷和 composer 均接入；内影复用有界图集 |
| 8. 流式渐显 | 18+ TextRenderer；17 直接显示 | 保留 Text 布局 / 语义，仅绘制新增字素；代码使用等宽字体 |
| 9. 图标 0.125em | 首行基线光学校正 | 文字旁图标做相应位移；独立按钮居中 |
| 10. 等宽数字 | 所有文字 token 使用 monospacedDigit | 所有 Typography 槽使用 tnum |
| 11. 0fr → 1fr 折叠 | 自然高度测量后裁切插值 | 同样方式；目录仍使用 LazyColumn |
| 12. 正文优雅断行 | 系统 Text | 原生 Paragraph 断行 |
| 13. 1200/80、380/18 | 自定义拖拽回位与勾选 | SwipeBack 与勾选；平台自身手势保留原生控制 |
| 14. 复制对勾 2.5s 恢复 | 共用复制按钮，重复复制重置计时 | Markdown 复制按钮，界面测试验证计时恢复 |
| 15. 无 UI 中点分隔符 | 移除自己生成的分隔符 | 移除自己生成的分隔符，并更新原 UI 用例 |
| 16. 无新增重复说明 | 移除冗余操作解释 | 移除待确认重复说明，错误细节仍可打开查看 |
| 17. 不超过四档、最小 12 | 20 / 15 / 13 / 12 | 20 / 15 / 13 / 12，覆盖全部 Material Typography 槽 |

流式字形单次渐显 120ms、错开 30ms；批量到达等待最多 450ms，Android 活动字素最多 128 个。
这避免历史大块内容造成长时间的排队动画。系统减少 / 关闭动画时直接显示。
用户主动展开、正文增长、输入换行和键盘出现会合理改变布局；这里验收的是其余元素不因临时状态插拔而跳动。

## 已执行

- `scripts/check-ios.sh`：61 项同源核心测试通过，Swift / plist / 工程检查和模拟器 Debug 构建通过。
- iOS：最终整组 12 项 UI 用例全部通过，新增长末尾回复阅读 / 跟随和审批覆盖面板提交时输入框不位移。
  共核对 9 个页面的 18 张明暗截图，另有目录、分支、工具、弹窗、长回复阅读 / 跟随和审批提交截图。
- Android：477 项单元测试通过；`assembleDebug` 和 `assembleDebugAndroidTest` 通过。
  设备用例覆盖长末尾卡片内阅读、工具提交、空投影恢复、显式回到最新、Markdown 文件链接、审批草稿、
  文件选择、provider 筛选及明暗主题的输入尺寸 / 扩展名 / 复制反馈。最终设备结果写在下方。
- Android 明暗控件截图已核对：卡片内代码和表格为平铺层，文件扩展名完整，聚焦不改变输入尺寸。

截图和结果包是本机验证产物，保存在工作树忽略目录 `.scratch/ui-polish/`，不作为构建输入。
iOS 使用专用 `Orbis UI Polish` 模拟器；Android 使用独立创建的 `Orbis UI Polish API 35`。
现有 Android 37 预览镜像无法运行本仓库的 Espresso 输入注入，已改用 API 35，未升级产品依赖来迁就预览镜像。

本轮未操作用户真机、真实配对、生产 Relay 或 Host。协议、跨 Host 行为和真实网络联调不属于这些 UI 夹具的结论。

## 复现

```sh
bash scripts/check-ios.sh
xcodebuild -project ios/Orbis/Orbis.xcodeproj -scheme Orbis \
  -destination 'platform=iOS Simulator,id=<专用模拟器 UUID>' \
  -derivedDataPath ios/Orbis/build/DerivedData -parallel-testing-enabled NO \
  -collect-test-diagnostics never CODE_SIGN_IDENTITY=- test

cd android
sh gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest
```

安装测试 APK 和执行设备测试时，显式指定专用模拟器 serial；不要在用户正在使用的手机上自动运行。
可使用测试类 `ChatViewportInstrumentedTest`、`MarkdownInstrumentedTest`、`InteractionWorkspaceInstrumentedTest`、
`UiPolishInstrumentedTest`、`SessionProviderFilterInstrumentedTest`、`DownloadFileBrowserInstrumentedTest`。
`UiPolishInstrumentedTest` 的输出截图在测试 App 自己的外部 files 目录。

## 最终设备结果

iOS：`ios-completed.xcresult` 的整组 12 项全部通过，零失败；审批覆盖面板的按钮可点击，提交中保持输入框坐标与高度。
iOS 17 的滚动兼容分支已编译，但本机没有单独运行 iOS 17 系统；该版本不启用模糊渐显。

Android API 35：19 项设备用例全部通过（含 4 项聊天视口、1 项 Markdown、5 项交互、3 项控件与字素、
3 项 provider 筛选、2 项文件浏览、1 项图形内存有界回归）。`android-completed.log` 保存最终输出。

文件浏览原测试还期待一条 HEAD 中并不存在的离线说明；按本轮去冗余文案约束，改为验证原路径保留且下载操作禁用。
问卷输入通过对应问题的可编辑节点定位；文件名在无障碍层仍作为完整名称提供。

## 合入主分支的回归

2026-10-29：将 `ui-polish` 的 `ce58df2` 合入 `main` 的 `df90054`。
合并保留主分支新增的多 Host、离线缓存、队列撤回、通知核对、Agent 状态、工具导出、完整内容读取和路径下载。
单项确认继续使用覆盖面板；多步骤交互使用可切换的面板并保存各项草稿。通知覆盖在聊天视口上方，避免插入提示时移动阅读位置。
主分支新增控件接入共用字号与输入聚焦组件，连接页复用顶栏的重连入口。

- iOS：172 项核心测试通过，模拟器 Debug 构建和应用包 WebRTC 检查通过。
- Android：478 项单元测试全部通过，Debug 和 AndroidTest APK 构建通过。
- iOS UI：整组 15 项中先通过 14 项；长回复夹具仍发送新版状态模型会忽略的旧生命周期事件，
  改成具有连续来源序号的 `session.patch` 后，长回复、审批、工具导出 / 交互草稿、完整内容四项定向回归全部通过。
  多步骤交互面板的顶部布局再单独复核通过。15 项不同用例均有通过结果；
  整组结果为 `ios-completed.xcresult`，修复后的结果为 `ios-integration.xcresult` 和 `ios-layout.xcresult`。
  主页、审批、工具导出和交互草稿截图已核对。

合并回归的本机日志和结果包保存在主工作树忽略目录 `.scratch/ui-polish-merge/`。

## 截图审查修复

2026-10-29：逐张核对两端明暗截图后的修复。工作树 `ui-review-fixes`，基于 `2d57907`。

- 多电脑：主页与会话目录只显示当前电脑（[ADR-0030 修订](../adr/0030-multi-host-mobile-connections.md)）；主页顶部固定一行显示当前电脑与连接方式，多台电脑时可在此切换；其他电脑有待确认时切换器显示红点，菜单写明是哪台。
- 叠压与占位：通知改为自带底色和关闭按钮的横幅，浮在正文上方；输入框上方不再常驻空白槽，单项确认以面板浮在输入框上方（Android 不再自动弹出整页）；Android 主页卡片的「待确认」并入状态位。
- 键盘：Android 主界面使用 `adjustResize`，输入区随键盘上移，顶栏不再被推出屏幕。
- 两端统一：连接胶囊（加密后显示连接方式）、会话行（agent 图标、状态、中文相对时间，仅在 provider 不同时标注）、新建会话两列网格与标题、用户消息右对齐气泡、回复复制按钮、工具行「名称 已完成」单行、斜杠命令排序与来源标签、排队消息「撤回」（Android 新增）与中文投递方式、状态页行式布局、设置页单层入口、聊天强调色跟随 agent。
- 细节：字标对比度、iOS 弹出面板改为 × 关闭、iOS 会话顶栏去掉「会话信息」按钮（点标题进入，别名在其中修改）、Android 下载页不显示「0 个任务进行中」。

验证：iOS 173 项核心测试、模拟器构建与 15 项 UI 用例通过；Android 480 项单元测试通过，受影响的 20 项设备用例通过。
两端明暗截图（含两台电脑与 iPad 布局）已逐张核对；预览可用 `--preview-hosts=2` 打开第二台电脑。
`SessionHostOwnership`、`CodexPermissions`（自由文本）、`Dsh`（新建会话说明）、`Questionnaire` 四项设备用例在未修改的 `2d57907` 上同样失败，与本轮无关，未处理。

## 卡片旁操作的间距与比例

2026-10-29：两端将会话别名、目录新建 / 会话菜单、下载动作作为卡片同级操作。
侧边圆面统一为 36pt / dp、图标 18pt / dp、触控区 48pt / dp，减轻阴影；
利用触控区自身留白保持约 6pt / dp 的可见间距，不再额外叠加列表间距。
供应商操作预留等宽槽，内容卡片的右边缘保持对齐。连接优先级使用连续文字行与小按钮，取消每行静态内容的凸起框。
聊天复制、通知关闭等依附内容的操作继续就近布局。

- Android：Debug 与 AndroidTest APK 构建通过；目录筛选与文件浏览 5 项设备用例通过，另复跑 1 项深色目录用例通过。
  375dp 宽的独立 API 35 模拟器中核对了目录明暗截图。
- iOS：冻结当前源码到隔离副本后，模拟器构建、明暗页面截图用例和设置排序 / 供应商切换用例通过。
  375pt 宽的 iPhone SE 模拟器产出 18 张页面截图，已核对受影响的主页、目录、设置、供应商明暗布局。
  冻结副本用于避免其他功能正在写入的接口影响本次布局验证。
- 首轮核心回归：Android 483 项、iOS 175 项通过。Android lint 被未修改的 `StreamingText.kt:96` 两处 `WrongConstant` 阻塞。

日志、源码快照和截图保存在忽略目录 `.scratch/adjacent-actions/`；`refined-light.png` / `refined-dark.png` 为最终截图拼图。
