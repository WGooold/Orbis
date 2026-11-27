# ADR-0093：聊天产物与本机下载的按需预览

日期：2026-11-20

状态：FILE-PREVIEW-01、02、03 已在 Host、iOS 和 Android 实现；FILE-PREVIEW-03 以原页离线渲染取代 01 的静态子集。FILE-PREVIEW-07 已实现，自动验证进行中。尚未部署，待用户验收。

关联：[文件范围下载](0005-receiver-driven-range-download.md)、[有界入站投递](0040-bounded-inbound-delivery.md)、[移动端性能](0060-mobile-relay-history-performance.md)、[协议兼容](0064-protocol-compatibility.md)、[消息内容投影](0084-host-normalized-message-content-rendering.md)。

## 背景

聊天中的文件引用和产物卡已经能按需下载；自包含的 HTML 报告、页面草稿和 SVG 图则需要浏览器排版才能阅读。预览应发生在文件出现的地方，同时保持聊天滚动、输入、回复和会话同步不依赖文件传输或页面渲染。

## 决策

### 1. 在原气泡内展开

- 复用消息里的文件引用卡和产物卡。支持预览的文件卡点文件本身即展开预览，行尾图标单独「下载原文件」；Host 不支持该类型的预览时，卡片保持原有下载卡。只展开这一个文件；打开会话、历史回放、滚动到未展开的卡片、收到流式更新均不触发预览下载或创建预览 WebView。普通 Markdown、代码围栏和网页链接保持原样。
- 预览默认收起。App 同时只保留一个展开的文件预览和一个预览用浏览器实例。内嵌区高度固定为 240 pt/dp，加载进度（已收／总字节）、渲染结果和错误共用这个位置，文档高度不带动聊天列表反复重排。网页在内嵌区渲染一次后换成静态截图，聊天列表里不常驻 WebView；点内嵌区进入「全屏」，沿用[共用整页导航](0054-shared-full-page-navigation.md)，用已取到的同一批文件交互、滚动和缩放，不再下载。返回保留截图和聊天阅读位置。
- 网页预览的范围、渲染与取件见 [FILE-PREVIEW-03](#file-preview-03原页离线渲染)。文件名只决定是否提供入口，最终按 Host 元数据和校验后的内容确定类型。编辑器、压缩包和音视频资源不在网页预览范围。错误按原因提示（不可用、无法预览、超过上限并标出上限、中断可重试），不能预览时保留原位的下载入口。

### 2. 区分预览件与完整产物

| 电脑上的内容 | App 取什么 |
| --- | --- |
| 单文件静态 HTML / SVG | 点「预览」才取该文件；点「下载」仍保存原文件。 |
| 多文件产物，生成方也提供 `preview.html` 或 `preview.svg` | 将预览件作为独立文件引用；只取用户点选的那份。完整产物如已有 ZIP，用户另点下载即可。 |
| 引用同目录或工作区内文件的入口（css、js、图片、字体等） | 只取页面渲染时实际请求的文件，逐个按需拉取；不扫描目录、不打包。远程资源不回源。 |

大附件保留各自的下载操作，不随入口预览。

参考：[Textastic](https://www.textasticapp.com/v10/manual/integration_other_apps/external_files_folders.html) 区分打开单文件和授权项目目录；[Quarto](https://quarto.org/docs/output-formats/html-basics.html#self-contained) 区分内嵌资源和依赖目录；[Plotly](https://plotly.com/python/interactive-html-export/) 说明单文件仍可能需要 JS；[GitLab](https://docs.gitlab.com/api/job_artifacts/#download-a-single-job-artifact-file-by-job-id) 区分整包与指定条目下载；[ReplayWeb.page](https://replayweb.page/docs/embedding/) 的索引与范围读取适合后续清单方案。

### 3. 只取用户选中的文件正文，分片走 `bulk`

不在消息、目录或会话同步里夹带正文。远程预览复用 `file.download` / `artifact.download`、`artifact.read`、`artifact.cancel` 和 `artifact.done`。`file.preview.started` / `file.preview.failed` 走独立的 E2E `ctl` 回包，不占用会话序号或进入普通下载状态。预览快照走端到端加密的 `bin` / `bulk`，LAN 和 Relay 使用同一通道划分。

- 原生格式在下载命令上带 `maxBytes` 与 `previewFormat`，网页带 `web`（见 FILE-PREVIEW-03），各自仅在加密的 Host 能力确认后发送。Host 在读取正文前执行上限，只接受当前设备的文件引用或已登记的产物 ID；摘要和范围读取指向同一份读出的正文，不使用可变路径的旧索引摘要。不带预览字段的普通下载保持原协议和行为。
- App 核对受理回包的文件身份、格式、长度和摘要格式后再拉取：每块至多 **128 KiB**，同一预览的所有文件共用一个在途窗口（**512 KiB**；会话同步或发送进行中收窄到 **128 KiB**），最早的请求先补齐。只在整页无进展时重传最早缺的一块（3 s 起指数退避、最多 3 次）；受理等待 15 s。没有总时长上限，慢链路只要持续有进展就不中断。WS/LAN 上已经发送的分片仍占带宽，`bulk` 优先级不能替代在途上限，也不为预览增大共享队列。
- 只在内存中保留本次预览，不进入普通下载队列或系统下载目录（MP4 播放除外，见 FILE-PREVIEW-02）。控制帧消费不等待 SHA-256 校验或内容准备；这些步骤走有界后台任务，聊天只更新相关卡片的展开状态和阶段。完整长度和摘要验证通过后才交给渲染器，并沿用 `artifact.done` 收尾。校验失败不展示部分内容。
- 不支持该能力的 Host 仍可使用普通下载。远程预览不静默改发无上限下载。旧 App 的命令与回包格式不变。能力按当前加密路径确认，不按协议号推断；发布前需要核对实际旧版本。

实现：[Host 下载服务](../../packages/host/src/artifact-download.ts)、[静态内容准备](../../packages/host/src/static-file-preview.ts)、[Host `bulk` 封帧](../../packages/host/src/device-link.ts)、[iOS 预览接收](../../ios/Orbis/Orbis/ChatFilePreview.swift)、[Android 预览接收](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreview.kt)。

### 4. 预览随气泡生命周期，浏览器只读本次文件

- 预览状态绑定配对、会话、消息内文件块、Host 文件身份及本次请求代次。收起、换预览、离开会话、切电脑或 App 进后台时停止拉取、取消该页所有传输（含 Host 尚未受理的）并释放视图。加载中完全滚出可见区或断线也停止；滚回或重连不自动续传，用户可在原位点重试。已校验的页面在断线后仍可从内存阅读，只结束其未完成的附属文件。关闭先撤销本地所有权；迟到的受理回包只用于取消对应传输，不启动读取，迟到分片不更新气泡。连续切换合并到最后一个选择，旧请求仅保留有期限的取消记录。
- 两端只从内存提供经校验的文件，浏览器隔离见 FILE-PREVIEW-03。气泡不挂载离屏 WebView。资源规则编译失败、渲染进程退出时释放实例；全屏时返回原气泡，在文件卡内提示并保留下载。

平台依据：[Apple 自定义资源处理](https://developer.apple.com/documentation/webkit/wkurlschemehandler)、[WebKit 资源阻断规则](https://developer.apple.com/documentation/webkit/wkcontentruleliststore)、[Android 本地内容加载](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content)、[Android WebView 文件访问边界](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)。

## FILE-PREVIEW-03：原页离线渲染

FILE-PREVIEW-01 只接受 HTML／CSS 静态子集。用 60 个本机 Agent 生成的 HTML（设计稿、报告、宣传页）复核，0 个通过：脚本、CSS 变量、grid、`@media`、`<img>`、渐变均被整份拒收；约三分之一还引用同目录文件。该子集与协议 `file.preview-v1` 未发布，直接替换。

### 渲染与隔离

- 渲染原始 HTML／SVG，页面脚本运行；网络、App、其他页面和持久存储均不可达。App 用自定义入口（iOS `orbis-web-preview://<页>/`，Android `https://<随机>.orbis-preview.invalid/`）应答页面的每个请求：入口、本页已取到的文件，或按需向 Host 取的新文件；其余返回 404。
- iOS：非持久数据存储、资源阻断规则只放行本页入口及 `data:`／`blob:`／`about:`（WebKit 规则不支持正则 `|`，规则编译失败即不渲染）；文档开始前移除 `RTCPeerConnection` 等点对点接口和 `sendBeacon`。拒绝新窗口、权限请求、弹框和上下文菜单。Android：`blockNetworkLoads`、关闭文件与内容访问、拦截全部请求；同样移除点对点接口（插在 doctype 之后，保持标准模式）；拒绝权限与弹框，关闭 Safe Browsing；页面的 DOM 存储随来源在释放时删除。两端的 HTML／SVG 应答带 CSP，限定为本页来源、内联脚本样式与 `data:`／`blob:`，`form-action 'none'`。
- 导航只允许入口一次及页内跳转，链接不离开预览。内嵌区渲染完成（或 12 s 未完成）后截一次图，之后撤下 WebView；全屏是可交互的同一页面。
- 消息里的文件引用按路径打开当前文件：Agent 重写同名文件（含写新文件再替换）后，新旧卡片都能预览和下载当前内容；一次读取期间文件被替换则该次失败（见 [ADR-0084](0084-host-normalized-message-content-rendering.md)）。
- 权衡：脚本本身来自用户电脑上的 Agent，在电脑上它已有更大的权限；在手机上断网、无桥接、无持久存储时，它能做的事少于在电脑上。剩余风险是渲染引擎本身的漏洞和耗电，由系统 WebView 更新、单实例及截图后撤下控制。

### 站点范围

页面的站点根：引用登记在会话工作目录内时为工作目录，否则为页面所在目录。资源路径是站点根下的解码 URL 路径：拒绝 `..`、反斜杠、冒号和控制字符；页面自身目录以下的隐藏文件或目录（`.` 开头）不提供；符号链接解析后必须仍在站点根内；只提供列出的 Web 类型（HTML、CSS、JS、JSON、文本、XML、wasm、字体、常见图片），音视频与压缩包不在其中。

### 取件与带宽

| 规则 | 取值 |
| --- | --- |
| 何时取 | 入口在用户点开时取；其余文件只在 WebView 请求时取，同一路径只取一次。 |
| 上限 | 入口 4 MiB，单个资源 8 MiB；每页最多 256 个文件、32 MiB 传输量；Host 每设备 6 个、全局 48 MiB 预览正文。 |
| 压缩 | 文本类正文压缩省出 5% 以上时用 raw DEFLATE 发送；摘要与长度按解码后的正文校验，解码必须恰好等于声明长度。非 UTF-8 文本不声明字符集，由页面自身声明决定。 |
| 首块 | App 自选 `transferId`，Host 受理回包后立刻送出第一块（≤128 KiB），小文件一次往返完成；首块先于回包到达也能认领。 |
| 窗口 | 同一页所有文件共用 512 KiB 在途窗口，会话同步或发送进行时 128 KiB；之后的块由 App 按范围请求。 |
| 复用 | App 在当前连接内按「文件身份 + 路径」保留最多 24 MiB 已校验正文；再次打开时带摘要请求，Host 内容未变只回「未修改」，不传正文。收起、进出全屏、滚出再滚回都不重新下载。 |
| 取代 | 打开另一页即取消本设备此前的所有预览传输（含 Host 正在准备的），不影响普通下载；Host 端预览传输 30 s 无读取即释放。 |

协议：`file.download`／`artifact.download` 带 `web: { page, transferId, resource?, ifNoneMatch? }`，仅在 Host 公告 `file.preview-web-v1` 后发送；`file.preview.started` 的 `format: "web"` 增加 `contentSize`、`encoding`、`mimeType`、`resource`、`notModified`。普通下载与原生格式的命令不变。

实现：[协议](../../packages/protocol/src/file-preview.ts)、[站点范围与读取](../../packages/host/src/file-preview-source.ts)、[Host 受理](../../packages/host/src/artifact-download.ts)、[iOS 接收](../../ios/Orbis/Orbis/ChatFilePreview.swift)／[视图](../../ios/Orbis/Orbis/ChatFilePreviewView.swift)、[Android 接收](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreview.kt)／[视图](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreviewView.kt)。

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

- HTML/HTM、SVG 按 FILE-PREVIEW-03 离线渲染原页。下载页里已保存的 HTML/SVG（4 MiB 内、摘要相符）在同一离线阅读器打开，只提供该文件本身，引用的其他文件缺失而不回源；分享或交给其他 App 仍可用。
- JPEG、PNG（8 MiB，最多 1600 万像素）：气泡内缩略图，全屏可缩放；iOS ImageIO、Android BitmapFactory 采样解码。
- PDF（12 MiB，最多 100 页）：气泡内首屏，全屏逐页翻阅和缩放；iOS Core Graphics、Android PdfRenderer 只绘制当前页，不激活链接或表单。文本 `.txt/.log/.json/.csv`（256 KiB、UTF-8）保持只读等宽显示；`.md` 以相同上限交给原生 Markdown 阅读器渲染，不启动 WebView 或执行文档中的 HTML／代码，长内容限量展示（见 FILE-PREVIEW-07）。
- MP4（16 MiB，最长 3 分钟）：由用户在原卡点「预览」，校验后进入全屏；文件暂存到 App 私有目录，使用 iOS AVKit (`AVPlayerViewController`) / Android `MediaPlayer`，不自动播放、不边下边播、不请求外部媒体资源。不能播放、超限或中断时保留独立下载。
- Office (`.doc/.docx/.xls/.xlsx/.ppt/.pptx`) 聊天中先按「下载」。下载页在 iOS 用 Quick Look（最多 32 MiB 的已校验私有副本、禁用编辑），Android 可显式「用其他 App 打开」，只授予所选文件的读取权限；没有阅读器时原件仍可保存或分享。大文件不因进入下载页绕开 App 内置阅读器的限额。
- 原生格式需 Host 在加密握手声明 `file.preview-v2`，App 才发送标明格式的限额请求；网页需 `file.preview-web-v1`。Host 缺少某类能力时，该类文件卡保持原有下载卡，不显示预览入口、不发取件请求。不支持远程预览的文件仍可显式下载，支持的本机类型可离线读取。新格式只回应显式的限额请求，不主动推送。图片解码、PDF 绘制、文件读写和摘要校验移出 UI 线程；未校验或超限的文件不会交给阅读器。

实现：[工作区链接识别](../../packages/host/src/workspace-output-references.ts)、[消息投影](../../packages/host/src/device-message-rendering.ts)、[格式协议](../../packages/protocol/src/file-preview.ts)、[iOS 阅读器](../../ios/Orbis/Orbis/NativeFileReader.swift)、[Android 阅读器](../../android/app/src/main/java/com/orbising/orbis/NativeFileReader.kt)。

## FILE-PREVIEW-07：Markdown 文件阅读

- `.md` 仍通过已发布的原生文本预览协议传输（`previewFormat: text`，256 KiB，UTF-8 校验及摘要校验不变），仅在阅读器按 Markdown 内容展示；`.txt/.log/.json/.csv` 的纯文本行为不变。
- 聊天卡片内预览和全屏阅读都复用各平台现有的 Markdown 组件：iOS `MarkdownMessage`、Android `MarkdownText`。Markdown 语法的视觉呈现与聊天消息一致；文件内容继续受原预览截断上限约束。Markdown 中的 HTML 和代码按既有 Markdown 渲染器处理，不通过文件 WebView 执行。
- 实现：[格式识别与协议映射](../../ios/Orbis/Orbis/ChatFilePreview.swift)、[iOS 阅读器](../../ios/Orbis/Orbis/NativeFileReader.swift)、[Android 格式识别](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreview.kt)、[Android 阅读器](../../android/app/src/main/java/com/orbising/orbis/NativeFileReader.kt)。自动验证：iOS `ChatFilePreviewTests` 与 `ChatFilePreviewRendererTests`、Android `ChatFilePreviewTest` 与 `NativeFileReaderInstrumentedTest`（SC133）。

## FILE-PREVIEW-05：阅读页与图片查看

- 首次打开时阅读区先透明、再出现白底白框：Android 两个全屏阅读页（聊天全屏与下载页）未套共用页面框架，入场动画期间没有页面底色，顶栏也不避让状态栏；WebView 创建即铺白底，渲染完成前就露出白块。两端内嵌区在页面就绪时又从灰色底切成白色，加载圈压在白框里。
- 两端全屏阅读页使用与其他整页相同的顶栏和底色（Android 改用共用 `Scaffold` + `RemoteTopAppBar`，避让系统栏；下载页的「用其他 App 打开」改为顶栏图标，与分享并列，打不开时才在阅读区顶部提示）。内嵌区在加载、渲染和结果阶段保持同一底色；网页在实际绘制前隐藏 WebView，绘制后淡入（减弱动态效果时直接显示）。
- 图片与 PDF 页全屏铺满阅读区，双指缩放至 4 倍，双击在点击处放大到 2.5 倍、再次双击复原；1 倍时单指横滑仍交给页面返回。气泡缩略图不变。

实现：[Android 视图](../../android/app/src/main/java/com/orbising/orbis/ChatFilePreviewView.kt)、[Android 阅读器](../../android/app/src/main/java/com/orbising/orbis/NativeFileReader.kt)、[iOS 视图](../../ios/Orbis/Orbis/ChatFilePreviewView.swift)、[iOS 阅读器](../../ios/Orbis/Orbis/NativeFileReader.swift)。

**自动验证（2026-11-22）：** [预览交互测试](../../android/app/src/androidTest/java/com/orbising/orbis/ChatFilePreviewInteractionTest.kt)新增入场取色（SC131）：用旧实现构建的对照包在全屏入场 160 ms 时取到纯白（255，页面底色 230），[对照失败](../../.artifacts/file-preview-05/android-device-baseline/instrumentation.log)；候选包该用例与原生阅读器、渲染器共 6 项[通过](../../.artifacts/file-preview-05/android-device/instrumentation.log)。[iOS 模拟器构建](../../.artifacts/file-preview-05/ios-build-3/run.log)通过，未跑 iOS 设备测试。双击缩放与淡入的手感待用户验证。

**FILE-PREVIEW-05 安装包（待用户验证）：** 基于 `2cd60dd1` 加本节改动的 ARM64 Release，`0.1.60`（61），签名与既有发布一致，可覆盖升级；第二版（`-r2`）把「用其他 App 打开」移到顶栏，[下载页与预览设备测试](../../.artifacts/file-preview-05/android-device-2/instrumentation.log) 5 项通过；[包与摘要](../../.artifacts/file-preview-05/deliverable/)，[构建记录](../../.artifacts/file-preview-05/android-release/)。未登记共享 QA。

## FILE-PREVIEW-06：全屏网页的横滑归属

全屏网页（聊天全屏与下载页）在阅读区内起手的横滑交给页面本身（轮播、横向滚动表格、图表拖动、放大后平移），不再触发整页右滑返回；从左边缘 24 pt/dp 内起手、在顶栏横滑、系统返回手势和返回键照常返回。不按「网页是否已滚到最左」判断：脚本自行处理触摸的页面不滚动，无法可靠区分。图片、PDF、文本阅读器不变。规则与共用实现记在 [ADR-0054](0054-shared-full-page-navigation.md) 的例外修订。

**验证与安装包（2026-11-22，待用户验证）：** 安装包在隔离工作树构建，仅含 `2cd60dd1` 与本节及 FILE-PREVIEW-05 改动（[补丁](../../.artifacts/file-preview-05/scope.patch)），原生 QUIC 库用本机 Go 工具链重新编译。[设备测试](../../.artifacts/file-preview-05/candidate-device/instrumentation.log) 8 项中 7 项通过，含 SC132（阅读区内右滑不关闭、左边缘起手返回）；`HomeSwipeCloseInstrumentedTest` 的关闭进度圈用例失败，未含本节手势改动的[对照包](../../.artifacts/file-preview-05/android-device-3-control/instrumentation.log)同样失败，与本节无关，保留原断言。iOS [模拟器构建](../../.artifacts/file-preview-05/ios-build-4/run.log)通过，未跑 iOS 设备测试。ARM64 Release `0.1.60`（61），签名与既有发布一致，[包、摘要与混淆映射](../../.artifacts/file-preview-05/deliverable/)。此前 `-r2` 包构建时共享工作树里有其他任务未提交的改动，已由本包取代。

## 取舍

默认就地预览比跳转单独浏览器更便于结合上下文阅读；内嵌截图与全屏入口把长文档滚动和聊天手势分开，聊天列表里不常驻 WebView。每个文件完整校验后再交给页面，不随分片渐进渲染；代价是要等该文件传完，收益是不展示未校验的内容。运行原页脚本换来真实页面的可读性，以断网、无桥接、无持久存储和单实例换取隔离；远程资源不回源，依赖 CDN 的部分会缺失，普通下载保留原件。按需取件比打包整站省流量，代价是多级依赖各多一次往返，由首块随回包抵消一部分。远程预览需要新 Host，旧端保留下载能力。

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
| SC124 | 原页（脚本、CSS 变量、grid、媒体查询）按原样渲染；入口压缩传输、首块随回包，解码后长度与摘要一致才显示。 |
| SC125 | 页面只能取站点根内列出类型的文件；越界、隐藏、符号链接外逃、未列类型与外部地址均无正文；外网请求与点对点接口不可用。 |
| SC126 | 收起再开、进出全屏、滚出滚回均不重新下载；内容未变时只回「未修改」；弱网下进度连续、不因总时长中断。 |
| SC127 | 打开另一页或关闭时取消该页全部传输；迟到回包与分片不影响当前卡片和普通下载；资源失败只影响该资源。 |
| SC128 | 内嵌区显示渲染后的截图，聊天列表无常驻 WebView；点截图进入可交互全屏，返回保留截图与阅读位置。 |
| SC129 | Agent 重写已预览过的文件后，新旧卡片都打开当前内容；读取进行中被替换的文件不展示。 |
| SC130 | 下载页里摘要相符的 HTML／SVG 在离线阅读器中打开并运行脚本；摘要不符时不渲染。 |
| SC131 | 打开内嵌预览和全屏阅读页时不透出下层页面、不先出现白底；全屏顶栏不压状态栏；图片双击放大与复原，1 倍时横滑返回。 |
| SC133 | `.md` 在卡片与全屏阅读器中将标题、强调和列表渲染为 Markdown；保持 `text` 协议、限额和 UTF-8 校验，不把内容交给 WebView；普通文本仍按原样显示。 |
| SC132 | 全屏网页阅读区内起手的右滑不关闭页面、不带动外层页面；从左边缘起手仍返回聊天并保留阅读位置。 |

**FILE-PREVIEW-01 初次验证（主工作树证据）：** [Host／协议及隔离 LAN、Relay 联动](../../.artifacts/file-preview-01/host-final-verification.log)覆盖超限拒绝、指定范围与摘要、普通下载及序号不受影响；[iOS 单测](../../.artifacts/file-preview-01/swift-final/run.log)和 [Android 单测](../../.artifacts/file-preview-01/android-visual-state/test-results/testDebugUnitTest/)覆盖按需拉取、选择代次、迟到回包、摘要错误与无能力回退。两端使用合成文档验证了实际渲染像素：[iOS WebKit](../../.artifacts/file-preview-01/ios-paint-device/tests.xcresult)、[Android WebView](../../.artifacts/file-preview-01/android-visual-device/device-files/SC119-static-preview.png)。Android 设备用冻结源码构建；iOS 定向设备测试未运行已有编译错误的 `ChatNativeSnapshotTests`。

**2026-11-21 工作树回归：** [Host／协议单测](../../.artifacts/adr-0093-worktree/host-baseline.log)与 [LAN／Relay 联动](../../.artifacts/adr-0093-worktree/host-wire.log)重跑通过。[iOS 单测](../../.artifacts/adr-0093-worktree/swift-final/run.log)与 [Android 单测](../../.artifacts/adr-0093-worktree/android-build-compiled/test-results/testDebugUnitTest/)确认已受理的文件滚出视口后停止拉取、忽略迟到分片，iOS 旧会话退出不会关闭新会话的预览。[Android 模拟器](../../.artifacts/adr-0093-worktree/android-device/instrumentation.log)在 80 条合成列表中验证默认不拉取、不创建浏览器、全屏往返保留阅读位置、滚回时复用快照。[iOS 模拟器](../../.artifacts/adr-0093-worktree/ios-device-retest/tests.xcresult)验证 WebKit 实际绘制和注入渲染失败后的原位回退；仍排除 `ChatNativeSnapshotTests`，保留[首次运行结果](../../.artifacts/adr-0093-worktree/ios-device/tests.xcresult)。

**FILE-PREVIEW-02 自动验证（2026-11-21）：**

- [Host 单测 19 项](../../.artifacts/adr-0093-media/node-final-units.log)、[协议 30 项](../../.artifacts/adr-0093-media/protocol-final.log)、[隔离 LAN／Relay 联动 5 项](../../.artifacts/adr-0093-media/host-wire-final.log)通过。联动覆盖完成回复中的工作区链接投影为设备文件句柄、点击前无正文、选中后按范围读取，以及预览不影响普通下载。
- [发布 Host 对照 4 项](../../.artifacts/adr-0093-media/host-release-compat-2.log)通过。使用 `v0.1.24`（`f6c2a707`）原始源码构建的 Host 与协议实现，对照候选 Host；两端分别验证 LAN、Relay、重新握手后的能力公告与普通下载，使用发布版解码器核对普通响应。该对照不等同于已发布手机包实测。
- [iOS 单测 24 项](../../.artifacts/adr-0093-media/swift-tests/run.log)、[最终模拟器 4 项](../../.artifacts/adr-0093-media/ios-final-device/tests.xcresult)通过，覆盖 WebKit 绘制及失败回退、JPEG/PNG、逐页 PDF、纯文本、本机 MP4 就绪但暂停、本地副本摘要重验与 Office 私有副本暂存。设备选择仍不含原有的 `ChatNativeSnapshotTests`。
- [Android 单测 15 项](../../.artifacts/adr-0093-media/android-build-final/test-results/testDebugUnitTest/)、[定向模拟器 7 项](../../.artifacts/adr-0093-media/android-device-targeted/instrumentation.log)通过，覆盖长列表中的预览交互、实际阅读器、点击播放、下载卡离线打开和多选。扩大回归的电脑文件选择器用例未通过：`D:\` 匹配两个语义节点，[同条件基线复现](../../.artifacts/adr-0093-media/android-baseline-device/instrumentation.log)，保留[首次结果](../../.artifacts/adr-0093-media/android-device/instrumentation.log)和原断言。
- [TypeScript 类型检查](../../.artifacts/adr-0093-media/node-typecheck-delivery.log)、改动文件 lint 和[本地化检查](../../.artifacts/adr-0093-media/localization-check.log)通过；[全仓 lint](../../.artifacts/adr-0093-media/lint-final.log)仍有基线 `host-state-facts.ts` 的一处未使用变量。

**FILE-PREVIEW-03 自动验证（2026-11-21）：**

- 复核 60 个本机 Agent 生成的 HTML：静态子集 0/60 通过；新 Host 读取 60/60。19 个文字类页面传输量 2156 KiB → 596 KiB（压缩比 3.6），含内嵌位图的宣传页整体 1.5（[记录](../../.artifacts/file-preview-03/real-html-host.json)）。
- [Host 单测](../../packages/host/src/file-preview-source.test.ts)覆盖原页压缩与首块、未修改回包、站点范围（越界、隐藏、符号链接、类型）、页面取代与并发上限、非 UTF-8 字符集；E2E LAN／Relay 联动覆盖首块走 `bulk` 及其余范围；[全仓 Node 测试](../../.artifacts/file-preview-03/node-full.log) 260 个文件 2805 项通过；[v0.1.24 Host 对照](../../.artifacts/file-preview-03/host-release-compat.log) 4 项通过。全仓 lint 仍只有基线 `host-state-facts.ts` 一处。
- [iOS 单测](../../.artifacts/file-preview-03/swift-tests/run.log) 8 项、[Android 单测](../../.artifacts/file-preview-03/android-build/test-results/testDebugUnitTest/) 8 项，两端同一组用例：首块先于回包、窗口收窄、解码后长度与摘要、按需取件与去重、并发 4、摘要复用、关闭取消与迟到数据、断线保留已就绪页面、有限重传、能力缺失时保持下载卡。
- [iOS 模拟器](../../.artifacts/file-preview-03/ios-device-4/tests.xcresult) 6 项、[Android 模拟器](../../.artifacts/file-preview-03/android-device/instrumentation.log) 5 项与[卡片截图轮](../../.artifacts/file-preview-03/android-device-4/device-files/)通过：真实 WebKit／WebView 运行页面脚本，按需取同目录 CSS、JS、图片，外网请求被拦截、点对点接口不可用；内嵌区得到截图并撤下 WebView；全屏往返与滚出滚回不再发请求、保留阅读位置；原生阅读器不变。卡片各状态截图见 [iOS](../../.artifacts/file-preview-03/ios-attachments-4/) 与 [Android](../../.artifacts/file-preview-03/android-device-4/device-files/SC128-chat-card.png)。
- 第二轮（SC129、SC130 及遗留问题）：Host 单测覆盖重写文件后新旧卡片可预览、读取中被替换仍拒绝；[全仓 Node](../../.artifacts/file-preview-03/node-full-2.log) 2806 项通过，[全仓 lint](../../.artifacts/file-preview-03/lint-full.log) 无错误（修复基线 `host-state-facts.ts` 未使用变量）。[iOS 预览设备测试](../../.artifacts/file-preview-03/ios-device-6/tests.xcresult) 7 项、[Android](../../.artifacts/file-preview-03/android-device-6/instrumentation.log) 9 项通过，含下载页离线打开 HTML（摘要不符不渲染）。电脑文件选择器原先在当前位置文字和预填的路径输入框里重复显示同一路径，两端合并为一个路径框（右侧按钮未改动时刷新、改动后跳转、加载时显示进度），此前基线失败的 `D:\` 选择器用例随之通过。`ChatNativeSnapshotTests` 自 `0d9d4fd4` 起漏改回调签名而无法编译，已修复，现可编译运行：9 项通过，剩余 1 项为 ADR-0082 已记录的展开中间帧失败。
- 设备测试首次运行发现并修复：WebKit 资源规则不支持正则 `|`，规则编译失败导致不渲染（[首次结果](../../.artifacts/file-preview-03/ios-device-first/tests.xcresult)）；Android Chromium 自行请求 `/favicon.ico`，每页多一次 Host 往返，改为本地 404（[首次结果](../../.artifacts/file-preview-03/android-device-first/instrumentation.log)）。另有两次 Android 运行因工具参数（默认包名、重复的 Gradle 参数）无效，保留在同目录。Android 构建复用本工作树已生成的 QUIC AAR（Go 工具链不可用；原生源码自 11-16 未变），[哈希记录](../../.artifacts/file-preview-03/quic/reuse.json)。

**待用户验证：** 真机上打开真实 Agent 页面（含同目录 css／js／图片）的内嵌截图、全屏交互和返回；Relay 弱网下的进度与输入延迟；Office Quick Look 和 Android 外部阅读器；已发布手机包的互通矩阵。未部署、未登记候选轮次；纳入可发布的独立候选后登记共享 QA，由用户领取、安装并记录验收。
