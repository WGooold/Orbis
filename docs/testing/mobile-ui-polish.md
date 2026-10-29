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
