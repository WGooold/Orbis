# Orbis Android 客户端

使用原生 Android 和 Jetpack Compose 实现的移动客户端。`minSdk 26`（Android 8.0）、`targetSdk 35`。

## 构建

使用 Windows PowerShell、Windows JDK 17+（建议 Android Studio 自带的 JBR）和 Android SDK 35。设置 `JAVA_HOME`、`ANDROID_HOME`，并让 `ANDROID_SDK_ROOT` 与 `ANDROID_HOME` 相同。在仓库根目录运行：

```powershell
scripts/windows/android-build.ps1 testDebugUnitTest assembleDebug
```

脚本通过 Windows named mutex 串行化构建，并记录 APK 来源和 SHA-256。产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。Debug 预览使用本机 Android debug 签名；正式分发应使用私下保存的发布签名，切勿提交签名文件。

构建锁默认使用已有 `D:\android-emulators\leases`；其他机器使用 `%LOCALAPPDATA%\Orbis\android-leases`。可统一配置 `ORBIS_ANDROID_LEASE_DIR`，同机工作树必须共享锁目录。模拟器需要独立 owner 记录；受管设备只通过 `scripts/windows/android-install.ps1` 或构建脚本的 `-InstallSerial` 安装，不能清除或覆盖其他工作树的设备数据。

客户端支持 `wss://`，也支持本机、私有局域网和 `.local` 主机的 `ws://` 地址。Android 模拟器连接电脑本地 Relay 时可使用 `ws://10.0.2.2:8787`；实体手机应使用电脑的局域网 IP。公网 Relay 仍必须使用 `wss://`。

## 配对与身份

配对页支持「扫码配对」：在电脑上执行 `pi-remote pair` 打开配对窗口，终端打印的二维码扫一下即完成配对，不需要再输入任何密钥或配对码。

二维码由 **Host** 生成，里面带着 Host 公钥与一次性配对密钥。**Host 公钥只经「屏幕 → 摄像头」这条物理路径到达手机，它是整条信任链的根**：之后无论走哪条路径，手机只认这个公钥。客户端用自己的长期设备私钥与 Host 握手，双方各自落一条配对记录；手机侧的身份种子用 Android Keystore 里硬件支持的 AES-256-GCM 密钥封装后落盘（不依赖 Keystore 原生 X25519）。相机权限只用于本地识别二维码，二维码内容不会上传到第三方服务。

配对记录由 **Host** 保管（`~/.pi-remote/`），不是 Relay 签发的。撤销在电脑上做：`pi-remote devices revoke <id>`，是设备级的，不影响其他设备、也不必给其他设备重新配对。APP 里的「取消配对」只是设备侧主动解除并删除本地副本。

## 传输与加密

与 Host 之间流动的是端到端加密的 Envelope，中继只能读到路由头（帧种类、room、收发方、序号），读不到会话内容。客户端支持 **LAN**（WebSocket 直连）、**P2P**（WebRTC DataChannel）和 **Relay** 三条路径；Host 按设置页的连接优先级选择路径，界面显示当前生效的路径。命令与文件传输都遵循这个选择。

LAN 地址从配对二维码保存；已有配对会在加密握手后通过 `host.lan.request` / `host.lan` 向 Host 获取并保存最新地址，因此升级 Host 和 APP 后无需重新配对。默认连接电脑的 `42130` 端口、路径 `/v1/lan`。每条路径独立握手和加密；LAN 不发送 Relay 凭据，只信任能证明配对密钥的 Host。地址支持使用公网编号的校园局域网，Relay 地址的 TLS 限制保持原样。

LAN 地址不可达或握手失败时自动尝试下一个地址，并定期重试；LAN 断开后由 Host 宣布回落到剩余路径。已保存地址时，LAN 可以在 Relay 不可用的情况下独立建立连接。手机与电脑需能相互访问；若一直回落到中继，请在诊断记录中查看 `lan.connect` / `lan.path`，检查是否同网、Wi-Fi 是否启用了客户端隔离，以及电脑防火墙是否允许该 LAN 端口。

## 界面

聊天输入区使用附件、输入框、发送/停止按钮同一行的布局。每个会话通过对应 agent 的图标、名称与强调色区分；通用配对入口保持「连接你的电脑」，不绑定某两个 agent。控件与独立内容面共用新拟物材质，完整覆盖及平面例外见 [新拟物审计](docs/neumorphism-audit.md)，图标来源见 [Agent 标识](docs/agent-icons.md)。

输入框接受普通消息。输入 `/` 时会展开当前 runtime 动态发布的统一 Slash 命令菜单，其中包含可远程执行的内置命令、Skill、Prompt Template、扩展注册命令和 MCP 工具；各 backend 只发布它能兑现的子集。命令必须从菜单选择；任意手输的 `/...` 不会作为聊天消息发送，也没有独立的 Runtime Action 菜单。需要参数的内置命令会显示当前 runtime 提供的模型、Session 或 tree 候选项。

`/tree` 的候选项不铺在输入框下面，而是和聊天页顶栏的「历史与分支」入口一起打开 [历史与分支整页](docs/neumorphism-audit.md)：按轮次组织、默认只展开当前分支、其他分支折成一行摘要，搜索走独立输入框。点节点先预览附近的对话（不改动电脑端会话），底部再按节点类型给出「编辑这条消息并重新开始」或「从这条回复后继续」——两者都只发一条 `slash.execute { name: "tree" }`，节点 ID 不再进入聊天输入框。树的投影规则在 `HistoryTree.kt`，回归在 `HistoryTreeTest`。

页面不认识 agent：它只用当前 runtime 发布的 `tree` 命令选项，所以 Pi 与 Codex 走同一套界面。动作落点两边都是「原地」——Pi 在同一条 runtime 内移动 leaf，Codex 走 `thread/revert` 截断当前会话。成功后 APP 会立刻拉一次快照：后端广播的快照用自造 syncId，手机不采，不主动问就还显示着已经不存在的那几轮。

在线 Runtime 列表和聊天页支持为当前 Runtime/Session 设置仅在本 APP 中显示的别名；别名按 Relay、设备、Runtime 和 Session 保存在本机，留空即可恢复电脑端名称。首页、会话侧栏、聊天标题、只读历史和下载来源共用名称规则：APP 别名 → 电脑端会话名称 → 首条用户消息摘要 → Session ID。只读历史沿用该会话最近保存的别名；消息摘要统一取第一句、最多 40 字，助手开场白不作为会话名。Codex 的已有标题和自动命名通过 Host 的 thread 快照及改名通知同步，自动标题生成后会直接更新 APP，加载聊天记录不会再覆盖正式名称。此功能需要更新 APP，并构建、重启 Host。Runtime 负责在线窗口、命令路由和当前 branch cursor，不决定历史 cache 文件身份。

会话目录由 Host 聚合下发，按 cwd 分组，Pi 与 Codex 的会话在同一棵树里，`agentKind` 只做角标。点开一个只有历史、没在跑的会话会触发激活：Host 按会话记录里的原目录把 agent 拉起来；「新建」则进入只读的目录浏览，选好目录后由 Host 在那里起一个全新会话。

会话与目录统一归属当前配对的 `hostId`，侧栏显示这台电脑；会话中的可选 `hostname` 只提供名称，不能生成另一台主机。空会话、离线缓存、主机改名和目录筛选都不改变归属。Session Catalog 落盘时校验 Relay、设备与 Host 身份；旧缓存只在原配对的设备命名空间内迁移，保留已有会话与历史。新建操作要求已配对的加密连接，面板打开后更换配对会使原操作失效。

APP 启动时只加载并持久化轻量 Session Catalog；用户打开在线 Runtime 后，才根据其当前 Session 读取对应的本地加密 Entry Graph Cache。没有在线 Runtime 的 Session 只能从独立历史入口打开已有缓存，并且只读。聊天页采用聊天气泡布局，普通消息完整显示；thinking 和工具调用默认折叠，点击后查看完整内容。Android 按选中 Runtime 的 leaf 从共享 graph 计算 branch、compaction、custom message、工具关联和显示顺序；同一 Session 的不同 runtime 不会把 sibling branch 合并。graph 同步使用 `sessionId`、graph version、entry digest、leaf、branch fingerprint 和 `syncId`，可验证时只追加缺失 entry，否则完整替换。消息生成期间的内容只作为 runtime/session-scoped overlay，直到持久化 entry 可以关联。取消配对时会删除本地 Session catalog、graph cache 和相关本地数据。Slash 菜单来自当前 runtime 发布的 capability manifest；Android 只负责选择命令和参数，并通过统一的 `slash.execute` 提交，Session、分支、上下文、模型和 thinking level 的实际语义均由电脑端的 agent 执行。

聊天页标题下方显示当前会话工作目录的 Git 分支，Pi 和 Codex 共用这一入口。打开聊天、回到前台及前台每 15 秒向 Host 读取一次，也可点击分支行立即刷新。Host 根据已注册会话的真实工作目录读取 Git，支持子目录和独立 worktree；分离 HEAD 显示短提交号，读取不到则显示「未获取到 Git 分支」。这里显示的是磁盘工作分支，与聊天记录的会话分支无关。需要更新并重启 Host 后，新版 APP 才能收到分支信息。

### Markdown 消息

消息使用 CommonMark 解析器和原生 Compose 控件渲染，支持：

- ATX / Setext 标题、段落、分隔线、软换行和硬换行。
- 嵌套有序 / 无序列表、保留起始编号的有序列表、多段引用和只读任务列表。
- 可嵌套的粗体 / 斜体 / 删除线、行内代码、转义字符和 HTML 实体。
- 围栏代码块（包括尚未闭合的流式输出）及缩进代码块；保留原文，支持横向滚动和复制。
- GFM 表格：表头、列对齐、单元格内格式和链接；长内容换行，宽表格横向滚动。
- 行内链接、引用式链接、自动识别的网页 / 邮件链接和 HTTP(S) 图片。图片加载失败时保留替代文字和链接；电脑上的图片路径沿用文件下载入口。

文件链接从同一棵解析树提取，因此表格、列表及引用中的下载链接也能使用；带空格的路径写成 `[文件](<D:/My Folder/report.txt>)`。代码中的 Markdown 链接不会被当作可点击链接。任务复选框展示消息记录的状态，不在手机上修改原消息。

原始 HTML 按文本显示（行内 `<br>` 可换行），不运行网页脚本。LaTeX 数学公式和 Mermaid 图尚无专用渲染器，保留为文本或代码；代码块当前不做语法高亮。

解析与链接回归在 `MarkdownTest` 中；窄屏表格滚动、表格内下载点击和嵌套内容的真机测试在 `MarkdownInstrumentedTest` 中。

`gradle.properties` 已设置 `android.injected.androidTest.leaveApksInstalledAfterRun=true`。AGP 8.7.3 默认会在设备测试结束时卸载主 APP 和测试 APK，实际导致过配对、本地缓存和设置被清除；不要去掉此设置或覆盖成 false。设备测试会占用手机前台，优先使用测试设备，不在用户正在使用的手机上自动运行。普通升级用 `adb install -r`，无需卸载 APP。

```powershell
.\gradlew.bat testDebugUnitTest
```

在独立测试设备上运行界面测试：

```powershell
.\gradlew.bat connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=dev.pi.remote.MarkdownInstrumentedTest
```

## 文件

下载页通过「浏览电脑文件」打开与新建会话共用的目录选择器：从盘符 / 根目录逐层进入，支持返回上一级和刷新；选中文件后点击「下载到手机」，无需手输路径。新建会话只显示目录，下载选择器同时显示普通文件；加载、离线或读取失败时不能下载，失败可原地重试。主页面的下载入口和聊天页右上角的下载按钮打开的是**同一个页面**；消息中识别到的 Windows/Unix 文件路径仍可直接点击下载。文件列表需要更新并重启 Host。

**下载由电脑上的 Host 服务，与任何 agent 进程是否在运行无关**：命令寻址到 Host，Host 就地读盘分片发送并校验偏移与最终长度；下载任务和本地 `.part` 文件会持久化，连接中断或 App 重启后可从已接收 offset 继续下载。Android 10 及以上保存到系统“下载”目录，页面会显示最终保存位置。

上传则在输入框里进行：手机上的文件先上传落地，消息只携带已经完成的附件路径。上传任务与 `.part` 状态在手机侧持久化，续传按内容身份命中同一个 `.part`。

## 安全

设备凭据等价于「发消息 + 调用 runtime 发布的 Slash 命令 + 按路径读写 Host 账户可读写的文件」，而不是只读凭据。若需要整机隔离，请使用受限操作系统账户、容器或虚拟机。
