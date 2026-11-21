# ADR-0093：聊天产物与本机下载的按需预览

日期：2026-11-20

状态：FILE-PREVIEW-01 与 FILE-PREVIEW-02 已在 Host、iOS 和 Android 实现；尚未部署，待用户验收。

关联：[文件范围下载](0005-receiver-driven-range-download.md)、[有界入站投递](0040-bounded-inbound-delivery.md)、[移动端性能](0060-mobile-relay-history-performance.md)、[协议兼容](0064-protocol-compatibility.md)、[消息内容投影](0084-host-normalized-message-content-rendering.md)。

## 背景

聊天中的文件引用和产物卡已经能按需下载；自包含的 HTML 报告、页面草稿和 SVG 图则需要浏览器排版才能阅读。预览应发生在文件出现的地方，同时保持聊天滚动、输入、回复和会话同步不依赖文件传输或页面渲染。

## 决策

### 1. 在原气泡内展开

- 复用消息里的文件引用卡和产物卡。支持的文件显示文件名和「预览」，保留独立的「下载」操作。点「预览」只展开这一个文件；打开会话、历史回放、滚动到未展开的卡片、收到流式更新均不触发预览下载或创建预览 WebView。普通 Markdown、代码围栏和网页链接保持原样。
- 预览默认收起。App 同时只保留一个展开的文件预览和一个预览用浏览器实例。内嵌区高度固定为 240 pt/dp，加载、渲染结果和错误共用这个位置，文档高度不带动聊天列表反复重排。气泡内展示文档首屏，竖滑仍滚聊天；「全屏」沿用[共用整页导航](0054-shared-full-page-navigation.md)，用同一份已校验内容滚动和缩放，不再下载。切到全屏时撤下气泡内的浏览器；返回保留原预览和聊天阅读位置。
- 首版支持 `.html`、`.htm`、`.svg` 的 UTF-8 自包含文件：支持 HTML 标签、CSS 属性和 SVG 元素的静态子集，不支持所有浏览器特性。首版不接受内嵌位图，待有独立解码预算后再开放。文件名只决定是否提供入口，最终按 Host 元数据和校验后的内容确定类型；通用 MIME 不单独判定格式。编辑器、依赖目录、压缩包、外链资源和需要 JavaScript 才能显示的页面不在首版范围。不能预览时保留原位的下载入口。

### 2. 区分预览件与完整产物

| 电脑上的内容 | App 取什么 |
| --- | --- |
| 单文件静态 HTML / SVG | 点「预览」才取该文件；点「下载」仍保存原文件。 |
| 多文件产物，生成方也提供 `preview.html` 或 `preview.svg` | 将预览件作为独立文件引用；只取用户点选的那份。完整产物如已有 ZIP，用户另点下载即可。 |
| 只有依赖兄弟文件、远程资源或脚本的入口 | 不扫描目录、不自动打包、不回源。提示不能完整预览，保留该文件的下载；不暗示单独下载入口能得到整个站点。 |

以后如要预览多文件内容，另定义版本化的「入口 + 资源清单」和总量预算，先授权，再按需拉取清单内的文件。大附件保留各自的下载操作，不随入口预览。

参考：[Textastic](https://www.textasticapp.com/v10/manual/integration_other_apps/external_files_folders.html) 区分打开单文件和授权项目目录；[Quarto](https://quarto.org/docs/output-formats/html-basics.html#self-contained) 区分内嵌资源和依赖目录；[Plotly](https://plotly.com/python/interactive-html-export/) 说明单文件仍可能需要 JS；[GitLab](https://docs.gitlab.com/api/job_artifacts/#download-a-single-job-artifact-file-by-job-id) 区分整包与指定条目下载；[ReplayWeb.page](https://replayweb.page/docs/embedding/) 的索引与范围读取适合后续清单方案。

### 3. 只取用户选中的文件正文，分片走 `bulk`

不在消息、目录或会话同步里夹带正文。远程预览复用 `file.download` / `artifact.download`、`artifact.read`、`artifact.cancel` 和 `artifact.done`。`file.preview.started` / `file.preview.failed` 走独立的 E2E `ctl` 回包，不占用会话序号或进入普通下载状态。预览快照走端到端加密的 `bin` / `bulk`，LAN 和 Relay 使用同一通道划分。

- 在两个下载命令上增加可选 `maxBytes`，仅在加密的 Host 能力确认 `file.preview-v1` 后发送。Host 在读取正文前对源文件执行 **2 MiB** 上限，只接受当前设备的文件引用或已登记的产物 ID。Host 为选中的文件在后台生成最多 **1 MiB** 的静态预览快照；摘要和范围读取指向同一快照，不使用可变路径的旧索引摘要。不带限额的普通下载保持原协议和行为。
- App 核对受理回包的文件身份、格式、长度和摘要格式后才从偏移 0 发范围请求：每块至多 **128 KiB**、单预览最多一块逻辑在途，写入有界缓冲后再拉下一块；按偏移限次重传，交互通道有压力时暂缓发新请求。等待受理、拉取和校验均有期限。WS/LAN 上已经发送的分片仍占带宽，`bulk` 优先级不能替代在途上限，也不为预览增大共享队列。
- 只在内存中保留本次预览，不进入普通下载队列或系统下载目录。上限固定且同一时刻只保留一个活动预览，因此不需要临时文件或跨会话缓存。控制帧消费不等待 SHA-256 校验或内容准备；这些步骤走有界后台任务，聊天只更新相关卡片的展开状态和阶段。完整长度和摘要验证通过后才交给渲染器，并沿用 `artifact.done` 收尾。校验失败不展示部分内容。
- 不支持该能力的 Host 仍可使用普通下载。远程预览不静默改发无上限下载。旧 App 的命令与回包格式不变。能力按当前加密路径确认，不按协议号推断；发布前需要核对实际旧版本。

实现：[Host 下载服务](../../packages/host/src/artifact-download.ts)、[静态内容准备](../../packages/host/src/static-file-preview.ts)、[Host `bulk` 封帧](../../packages/host/src/device-link.ts)、[iOS 预览接收](../../ios/Orbis/Orbis/ChatFilePreview.swift)、[Android 预览接收](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreview.kt)。

### 4. 预览随气泡生命周期，浏览器只读本次文件

- 预览状态绑定配对、会话、消息内文件块、Host 文件身份及本次请求代次。收起、换预览、离开会话、切电脑或 App 进后台时停止拉取、取消已知传输并释放视图和内存快照。下载中完全滚出可见区或断线也停止；滚回或重连不自动续传，用户可在原位点重试。已校验、仍展开的预览离开视口时可只保留本次快照，回到可见区时从快照恢复。关闭先撤销本地所有权；迟到的受理回包只用于取消对应传输，不启动读取，迟到分片不更新气泡。连续切换合并到最后一个选择，旧请求仅保留有期限的取消记录。
- 两端只从内存提供经校验的文档。iOS 用 [WKWebView](../../ios/Orbis/Orbis/ChatFilePreviewView.swift) 的非持久存储、自定义入口和预先装载的资源阻断规则；Android 用 [WebView](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreviewView.kt) 拦截独立的本地文档地址，只响应一次精确的入口请求，同时保持网络、文件和内容访问关闭，不回退到网络。两端禁用页面脚本、原生桥接和新导航，不向页面提供 Host 路径或 App 文件。隔离或渲染失败时只提示并保留下载入口。
- 后台准备检查文档结构，拒绝外部依赖、脚本、能持续绘制的动画和暂未纳入预算的位图；文件字节上限不代替渲染预算。气泡不挂载离屏 WebView，也不在 WebView 回调中同步读文件。超预算、渲染超时或进程退出时释放实例；全屏时返回原气泡，在文件卡内提示并保留下载。后续若要支持脚本互动或多文件站点，单独评估权限和资源清单。

平台依据：[Apple 自定义资源处理](https://developer.apple.com/documentation/webkit/wkurlschemehandler)、[WebKit 资源阻断规则](https://developer.apple.com/documentation/webkit/wkcontentruleliststore)、[Android 本地内容加载](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)、[Android WebView 文件访问边界](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)。

## FILE-PREVIEW-02：在交付文件的位置打开

### 入口与识别

| 用户看到什么 | 在哪里点开 | 何时取正文 |
| --- | --- | --- |
| 已完成的模型回复交付文件：结构化产物、有 Host 句柄的 `output` 引用、适配器已绑定本机文件的生成图片 | 原回复的文件卡；支持格式显示「预览」，「下载」独立 | 点击预览才取一个有界快照；点击下载才保存原件 |
| 回复中的显式 Markdown 本地链接或图片，例如 `[报告](reports/summary.pdf)`、`![截图](./shot.png)`，目标是当前会话工作目录内的已知类型 | Host 投影成原回复的文件卡；预览按钮在卡片上，不改写正文链接的既有行为 | 相对工作目录登记，点选时检查实际文件和边界。同步不读文件，不扫描目录 |
| 正文、裸路径、代码块、输入图片/已有内联媒体、`source` 代码引用、网页 URL、工具日志、未绑定文件的生成结果 | 维持原有展示或引用行为，不作为产物建预览卡 | 不触发新的产物取件。HTML/SVG 源码块仍是代码；裸路径或 `sandbox:` 不是可用的 Host 文件身份 |
| 下载页的已完成条目（包括浏览电脑文件或手输路径后下载的文件） | 点击已完成的卡片，在全屏阅读器打开本机文件；分享或外部打开作为回退 | 不访问 Host，可离线；下载中、未校验、失败的条目仍只显示传输操作。「浏览电脑文件」仍只负责选取下载 |

是否显示入口根据文件类型及已有身份决定，是否能读由真实路径、内容、体积和平台解码结果决定。普通 Markdown 路径只认 Host 的本机会话工作目录，拒绝越界、网络和虚拟 URL；适配器可为已知的本机交付件提供独立身份。ZIP 等不支持渲染的类型保持下载，不解包。预览不建立下载记录，也不替代「下载」；同一展开预览的气泡和全屏共用一份已校验快照，收起后释放。

### 平台渲染与限额

Web 阅读器是 App 按需创建的系统组件实例：iOS `WKWebView`、Android `WebView`。不是打开或复用 Safari / Chrome，也不额外打包浏览器。其他格式优先使用原生解码和阅读组件，不经 WebView。

- 静态 HTML/HTM、SVG 保持 2 MiB 源文件、1 MiB 快照和 WebView 隔离；渲染的是 Host 准备的静态子集。下载页的 HTML/SVG 是未净化的原件，不直接进入 App WebView；可分享/交给其他 App。
- JPEG、PNG（8 MiB，最多 1600 万像素）：气泡内缩略图，全屏可缩放；iOS ImageIO、Android BitmapFactory 采样解码。
- PDF（12 MiB，最多 100 页）：气泡内首屏，全屏逐页翻阅和缩放；iOS Core Graphics、Android PdfRenderer 只绘制当前页，不激活链接或表单。文本 `.txt/.md/.log/.json/.csv`（256 KiB、UTF-8）：原生只读文本，不执行 Markdown/HTML、不解析为表格，长内容限量展示。
- MP4（16 MiB，最长 3 分钟）：由用户在原卡点「预览」，校验后进入全屏；文件暂存到 App 私有目录，使用 iOS AVKit (`AVPlayerViewController`) / Android `MediaPlayer`，不自动播放、不边下边播、不请求外部媒体资源。不能播放、超限或中断时保留独立下载。
- Office (`.doc/.docx/.xls/.xlsx/.ppt/.pptx`) 聊天中先按「下载」。下载页在 iOS 用 Quick Look（最多 32 MiB 的已校验私有副本、禁用编辑），Android 可显式「用其他 App 打开」，只授予所选文件的读取权限；没有阅读器时原件仍可保存或分享。大文件不因进入下载页绕开 App 内置阅读器的限额。
- 原生格式需 Host 在加密握手声明 `file.preview-v2`，App 才发送标明格式的限额请求。仅有 `file.preview-v1` 时仍可预览静态 HTML/SVG；缺少所需能力时，点预览在原卡提示不可用，不发取件请求，原下载入口仍可用。不支持远程预览的文件仍可显式下载，支持的本机类型可离线读取。新格式只回应显式的限额请求，不主动推送。图片解码、PDF 绘制、文件读写和摘要校验移出 UI 线程；未校验或超限的文件不会交给阅读器。

实现：[工作区链接识别](../../packages/host/src/workspace-output-references.ts)、[消息投影](../../packages/host/src/device-message-rendering.ts)、[格式协议](../../packages/protocol/src/file-preview.ts)、[iOS 阅读器](../../ios/Orbis/Orbis/NativeFileReader.swift)、[Android 阅读器](../../android/app/src/main/java/com/orbising/orbis/NativeFileReader.kt)。

## 取舍

默认就地预览比跳转单独浏览器更便于结合上下文阅读；固定首屏与全屏入口把长文档滚动和聊天手势分开。选择完整校验后再渲染，不随分片渐进渲染；代价是必须等选中的小文件传完，收益是避免逐片重排、不展示未校验的内容。只呈现静态子集，因而不能完整预览依赖外部文件或运行脚本的页面；普通下载保留原件。远程预览需要支持限额的新 Host，旧端保留下载能力。

## 验证与交付

| 场景 | 待验证的结果 |
| --- | --- |
| SC116 | 长聊天和历史回放中卡片默认收起、零预览请求及零预览实例；点一张卡只取一个文件，内嵌首屏和全屏共用一次下载，原阅读位置保留。 |
| SC117 | 下载中收起、滚出视口、换文件、断线、切 Host 或进后台后停止发新范围；迟到回包及分片不能复活旧气泡，普通下载不受取消影响。 |
| SC118 | 超限文件在 Host 算摘要前被拒绝；实际二进制分片走 `bulk` 且不突破单块预算。弱网与丢片下比较开关预览时的输入回显、聊天同步和滚动帧时间，记录尾延迟、重传及 UI 线程占用。 |
| SC119 | 真实双端渲染器呈现静态 HTML/SVG；错误摘要、禁用资源策略或渲染器退出走原位回退；外部资源、本地兄弟文件和导航均无请求。 |
| SC120 | 新 Host / 旧 App、旧 Host / 新 App 和同版正对照，覆盖 LAN、Relay 与重连；旧端正常下载，无能力时不自动退回无上限预览。 |
| SC121 | 完成回复的文件引用、生成图和显式工作区链接显示文件卡；流式文本、裸路径、代码、远程地址、非产物引用不创建新卡，不预取。 |
| SC122 | JPEG/PNG、PDF、UTF-8 文本各走原生阅读器；MP4 校验后打开、需再点击播放。错误类型、超量、摘要不符和迟到数据均不渲染。 |
| SC123 | 下载页只打开已完成的本机文件；离线查看不请求 Host。Office 与不支持类型保留系统回退，原件与聊天预览互不影响。 |

**FILE-PREVIEW-01 初次验证（主工作树证据）：** [Host／协议及隔离 LAN、Relay 联动](../../.artifacts/file-preview-01/host-final-verification.log)覆盖超限拒绝、指定范围与摘要、普通下载及序号不受影响；[iOS 单测](../../.artifacts/file-preview-01/swift-final/run.log)和 [Android 单测](../../.artifacts/file-preview-01/android-visual-state/test-results/testDebugUnitTest/)覆盖按需拉取、选择代次、迟到回包、摘要错误与无能力回退。两端使用合成文档验证了实际渲染像素：[iOS WebKit](../../.artifacts/file-preview-01/ios-paint-device/tests.xcresult)、[Android WebView](../../.artifacts/file-preview-01/android-visual-device/device-files/SC119-static-preview.png)。Android 设备用冻结源码构建；iOS 定向设备测试未运行已有编译错误的 `ChatNativeSnapshotTests`。

**2026-11-21 工作树回归：** [Host／协议单测](../../.artifacts/adr-0093-worktree/host-baseline.log)与 [LAN／Relay 联动](../../.artifacts/adr-0093-worktree/host-wire.log)重跑通过。[iOS 单测](../../.artifacts/adr-0093-worktree/swift-final/run.log)与 [Android 单测](../../.artifacts/adr-0093-worktree/android-build-compiled/test-results/testDebugUnitTest/)确认已受理的文件滚出视口后停止拉取、忽略迟到分片，iOS 旧会话退出不会关闭新会话的预览。[Android 模拟器](../../.artifacts/adr-0093-worktree/android-device/instrumentation.log)在 80 条合成列表中验证默认不拉取、不创建浏览器、全屏往返保留阅读位置、滚回时复用快照。[iOS 模拟器](../../.artifacts/adr-0093-worktree/ios-device-retest/tests.xcresult)验证 WebKit 实际绘制和注入渲染失败后的原位回退；仍排除 `ChatNativeSnapshotTests`，保留[首次运行结果](../../.artifacts/adr-0093-worktree/ios-device/tests.xcresult)。

**FILE-PREVIEW-02 自动验证（2026-11-21）：**

- [Host 单测 19 项](../../.artifacts/adr-0093-media/node-final-units.log)、[协议 30 项](../../.artifacts/adr-0093-media/protocol-final.log)、[隔离 LAN／Relay 联动 5 项](../../.artifacts/adr-0093-media/host-wire-final.log)通过。联动覆盖完成回复中的工作区链接投影为设备文件句柄、点击前无正文、选中后按范围读取，以及预览不影响普通下载。
- [发布 Host 对照 4 项](../../.artifacts/adr-0093-media/host-release-compat-2.log)通过。使用 `v0.1.24`（`f6c2a707`）原始源码构建的 Host 与协议实现，对照候选 Host；两端分别验证 LAN、Relay、重新握手后的能力公告与普通下载，使用发布版解码器核对普通响应。该对照不等同于已发布手机包实测。
- [iOS 单测 24 项](../../.artifacts/adr-0093-media/swift-tests/run.log)、[最终模拟器 4 项](../../.artifacts/adr-0093-media/ios-final-device/tests.xcresult)通过，覆盖 WebKit 绘制及失败回退、JPEG/PNG、逐页 PDF、纯文本、本机 MP4 就绪但暂停、本地副本摘要重验与 Office 私有副本暂存。设备选择仍不含原有的 `ChatNativeSnapshotTests`。
- [Android 单测 15 项](../../.artifacts/adr-0093-media/android-build-final/test-results/testDebugUnitTest/)、[定向模拟器 7 项](../../.artifacts/adr-0093-media/android-device-targeted/instrumentation.log)通过，覆盖长列表中的预览交互、实际阅读器、点击播放、下载卡离线打开和多选。扩大回归的电脑文件选择器用例未通过：`D:\` 匹配两个语义节点，[同条件基线复现](../../.artifacts/adr-0093-media/android-baseline-device/instrumentation.log)，保留[首次结果](../../.artifacts/adr-0093-media/android-device/instrumentation.log)和原断言。
- [TypeScript 类型检查](../../.artifacts/adr-0093-media/node-typecheck-delivery.log)、改动文件 lint 和[本地化检查](../../.artifacts/adr-0093-media/localization-check.log)通过；[全仓 lint](../../.artifacts/adr-0093-media/lint-final.log)仍有基线 `host-state-facts.ts` 的一处未使用变量。

**待用户验证：** 真机上的 Office Quick Look 和 Android 外部阅读器、真实长会话及弱网、已发布手机包的完整互通矩阵。未部署、未登记候选轮次；将 ADR 改动纳入可发布的独立候选后登记共享 QA，由用户领取、安装并记录验收。
