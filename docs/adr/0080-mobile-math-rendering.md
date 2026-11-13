# ADR-0080：移动端通用数学公式渲染

日期：2026-11-13

Status: accepted（范围确定；实现、自动验证、部署和用户验收分别记录）

关联：ADR-0051、ADR-0058、ADR-0060、ADR-0064。Feature：MATH-01。

## 问题与决策

Android 使用 CommonMark 加表格、删除线、任务列表与自动链接扩展；iOS 使用 Markdown 分块和 AttributedString。此前两端缺少数学解析与排版。NASA-TLX 示例中的行内、独立、多行对齐、求和、下标、帽子符号及方框属于通用 TeX / LaTeX / AMS 数学写法。本决策确定这些公式的兼容范围，Codex 其他输出格式是否包含私有扩展需要另外核对。

在两端共用的消息呈现层实现数学支持，对 Codex、Claude、Pi 及其他来源一致生效。保留消息原文、复制文本、来源身份、历史和流式同步协议；Host / Relay 不改写定界符，不把公式转换为图片传输。旧客户端仍能取得同一原文。

采用随 App 打包的 KaTeX 0.16.25 及字体，离线可用。两端共用同一引擎资源、配置及样例。普通正文继续原生呈现，数学排版限于含公式的文本段落或表格单元。含公式片段的字体、主题、链接、选择和尺寸变化与既有阅读行为衔接。

## 覆盖范围

| 场景 ID | 目标行为 |
| --- | --- |
| MATH-01-DELIMITERS | 行内支持反斜线圆括号及单美元；独立公式支持反斜线方括号及双美元。优先识别双美元。明确转义的定界符保持文字；单美元采用保守边界规则，货币金额和未闭合片段不跨段误配。 |
| MATH-01-TEX | 支持引擎公开集合内的上下标、分式、根式、希腊字母、集合与逻辑、关系、箭头、积分、求和、乘积、极限、导数、组合数、数学字体、重音、向量、可伸缩括号、间距、方框和颜色。具体命令以固定版本引擎与可执行样例为准。 |
| MATH-01-AMS | 覆盖 aligned、alignedat、gathered、cases、array、常见 matrix 家族，以及受支持的 equation / align / gather 环境；保留换行、对齐符和列格式。独立的受支持数学环境可作为公式块识别。 |
| MATH-01-TEXT | 支持 text 命令的中英文说明、中文标点和 Unicode 数学字符，使用随包数学字体与平台文字回退。 |
| MATH-01-CONTEXT | 覆盖正文、标题、强调、列表、引用、表格单元中的行内公式和独立公式块。公式内下划线、星号、竖线、反斜线和换行在 Markdown 解析前保护。math 围栏显式渲染；其他代码围栏、行内代码、缩进代码、链接地址和原始 HTML 保持原义。 |
| MATH-01-STREAM | 未闭合或语法暂时不完整时保留可读原文；完整后替换相应片段，不吞后续正文。解析走既有后台合并队列，迟到结果不覆盖较新内容，历史重放与实时输出遵循同一规则。 |
| MATH-01-LAYOUT | 跟随主题、系统字号和容器宽度；行内基线协调，长公式可局部横向滚动，块公式和矩阵完整显示。异步尺寸变化沿用阅读锚点；减少动画、选择、复制、链接和辅助功能保留可用性。 |
| MATH-01-RECOVERY | 不支持的命令、非法语法、资源失败和超限输入按片段回退完整原文，不显示空白，不让一个公式阻断整条消息。回退可复制。 |
| MATH-01-ISOLATION | 渲染不访问网络、不执行消息脚本，不开放任意 HTML / 文件访问或桥接能力。引擎使用非信任模式，限制输入长度、宏展开及排版尺寸；宏作用域不跨消息泄漏。 |
| MATH-01-PERFORMANCE | 数学识别、HTML 构造和可复用数据处理移出 UI 线程；排版使用独立渲染执行环境。缓存有界，键包含影响布局的配置，视图释放对应资源；普通 Markdown 不走新增路径。 |

## 能力边界

目标是聊天中的数学表达式，而非完整 LaTeX 文档编译。documentclass、任意宏包、TikZ / PGF、文件读写、外部资源、跨消息公式编号和交叉引用不作为本轮支持承诺。引擎支持的局部宏在资源限制内处理，未知宏保留原文。latex / tex 代码围栏保留代码展示语义；只有明确的 math 围栏进入数学排版。

美元符号存在货币与数学歧义，无法仅凭字符保证理解意图。单美元仅接受同一行内、非空且紧邻内容的配对；数字货币样式优先保留文字。反斜线定界符和双美元是明确入口。详细边界由共享样例与两端测试固定。

## 实现与资源边界

[共享扫描器](../../shared/math/core.js)在 Markdown 解析前保护公式，解析后恢复原文及原生文字属性；代码、链接地址、金额与 HTML 上下文采用共享夹具固定边界。Android 通过 Rhino 的安全作用域执行扫描器，iOS 通过串行化 JavaScriptCore 执行；输入以数据传入。现有 Markdown 后台队列负责识别和 HTML 准备。

[共享视图](../../shared/math/view.js)在本地 WebView / WKWebView 中执行真实数学排版。CSP 与原生请求入口限制资源为随包文件，导航回交既有原生链接处理。公式采用 HTML + MathML 输出；选择公式的部分字形时，复制扩展为该公式的完整 LaTeX 原文。流式显现沿用原生时钟，公式按完整单元出现；字体就绪后直接通知原生尺寸，避免初始隐藏视图等待动画帧而一直显示源码。

| 资源 | 当前限制与回退 |
| --- | --- |
| 单条输入 | 超过 262144 个 UTF-16 代码单元，或保护标记达到扫描上限 512 后仍有内容，整条保留原文。 |
| 单条公式 | 最多 16384 个 UTF-16 代码单元；每条消息最多 128 个可渲染公式、32 个数学视图片段，其余保留原文。 |
| 引擎 | `trust: false`、`throwOnError: true`、`maxExpand: 500`、`maxSize: 20`；每个表达式使用新的宏表。外链、图片及 HTML 扩展命令回退原文。 |
| 排版缓存 | 每个数学视图最多 128 项，键与 HTML 合计最多 1048576 个代码单元；单项 HTML 达到 262144 时不缓存。原生文档缓存同时计入生成 HTML 的成本。 |
| 视图尺寸 | 单公式高度超过 8192 CSS px 时回退；片段高度超过 32768 CSS px 时回到原生原文。长公式在片段内横向滚动。 |

资源固定在 [shared/math](../../shared/math/)，[vendor.json](../../shared/math/vendor.json)记录来源、npm 完整性与 SHA-256，[LICENSE](../../shared/math/LICENSE)保留 MIT 许可。Android 使用 variant generated-assets API 建立复制、合并、lint 与打包依赖；iOS 的 MathResources 指向同一目录。交付核对安装包内的资源与源码哈希。

实现入口：[Android 扫描适配](../../android/app/src/main/java/com/orbising/orbis/MathMarkup.kt)、[Android 后台准备](../../android/app/src/main/java/com/orbising/orbis/PreparedMarkdown.kt)、[Android 数学视图](../../android/app/src/main/java/com/orbising/orbis/MathFragment.kt)、[iOS 扫描适配](../../ios/Orbis/Orbis/MathMarkup.swift)、[iOS 后台准备](../../ios/Orbis/Orbis/Presentation.swift)、[iOS 数学视图](../../ios/Orbis/Orbis/MathFragment.swift)。

引擎依据：[KaTeX supported functions](https://katex.org/docs/supported)、[options](https://katex.org/docs/options)、[auto-render](https://katex.org/docs/autorender)。

## 验证与证据

合成夹具覆盖 NASA-TLX 加权求和、同人差值、共享评分函数、望远镜求和和中文 aligned，另含代码、货币、链接、HTML、嵌套围栏及失败输入。判断细节以测试源码为准：

- [共享夹具](../../shared/math-tests/fixtures.json)与[引擎测试](../../shared/math-tests/core.test.mjs)：28 个共享样例加 6 项专项测试；验证原文恢复、真实引擎编译和受限宏，已接入默认 Vitest 测试入口。
- [Android 单测](../../android/app/src/test/java/com/orbising/orbis/MathMarkupTest.kt)：真实 Rhino、CommonMark、样例一致性、表格及原生属性恢复。
- [iOS 单测](../../ios/Orbis/Tests/MathMarkupTests.swift)：真实 JavaScriptCore、AttributedString、表格、样例一致性与资源回退。
- [Android 设备测试](../../android/app/src/androidTest/java/com/orbising/orbis/MathRenderingInstrumentedTest.kt)与[iOS UI 测试](../../ios/Orbis/UITests/OrbisUITests.swift)：实际数学视图、原生尺寸、中文、矩阵、表格和流式补全；Android 检查公式复制，iOS 检查深浅主题。

本机证据根目录：`.artifacts/mobile-math-20261113/`。共享测试见 `shared-vitest.log`，静态检查见 `lint-final-3.log`，Android 12 项单测见 `android-release-4/test-results/`，Swift 38 项测试见 `swift-tests-final/`。浏览器 28 个样例、150/360px 宽度、深浅主题与字号、复制、错误回退、显现动画及零外部请求见 `browser-final-2/`。Android 两项模拟器测试及可见矩阵截图见 `android-device-package/`；iOS 一项双主题模拟器 UI 测试及截图见 `ios-device/`。浏览器、模拟器与人工安装验证分别记录。

首次失败证据保留在 `browser/`、`browser-2/`、`swift-tests-2/`、`android-release/`、`android-release-2/`、`android-release-3/` 与早期设备目录；对应窄单元溢出、资源链接、Release 缩减及初始尺寸问题已有后续通过记录。`android-release-4/asset-audit.json` 记录增量资源陈旧的首次失败；修复生成资源依赖后的 Debug / Release 构建与全部 28 个随包文件哈希核对见 `android-release-5/`。

## 交付状态

2026-11-13：Android / iOS 实现及上述自动验证已完成。Android 候选提交为 `b65703b95a45763d5f52a5f83fd7a30865c2eaf1`，后续测试入口和交付记录更新未改变该候选的产品代码。

Android 独立回归批次 `R-MATH-20261113` 已发布到[本机回归页面](http://localhost:18412/?batch=R-MATH-20261113)，状态 `ready`。ARM64 Release 安装包使用独立的 `com.orbising.orbis.qa` 身份，体积 27443453 字节；包身份、签名、ABI、ZIP 有效载荷、对齐与全部 28 个数学资源文件哈希已核对，混淆映射随包保留。证据见 `manual-package-audit.log`、`manual-asset-audit.json`、`delivery.json` 及 `/Volumes/WD1TB/Orbis/qa-lab/runs/R-MATH-20261113/`。

独立回归用例见本机证据目录的 `manual-cases-android.json` 与 `manual-cases-ios.json`，按平台分别登记公式、布局与流式场景。2026-11-13 16:49（Asia/Taipei），旧批次 `R-LAB-001` 环境已结束并保留原验收记录；本轮 Android 环境启动并通过配对、加密传输、真实 Host / Relay / Pi 与本地合成模型往返自检。证据见本批次 `probe.json`、`manual-start.log` 及旧批次 `environment-cleanup.json`。iOS 签名安装包待准备，iOS 人工用例随可安装产物另行交付。

用户验收：待用户验证。真实会话的阅读位置、整条消息选择、系统辅助功能与长时间滚动仍需人工验证。当前证据覆盖本地呈现与合成内容；Host / Relay 协议未修改，跨版本真实供应商会话未在本轮验证。
