# ADR-0085：从其他 App 导入内容与投递到会话（IMPORT-01–08）

日期：2026-11-19

状态：方案拟定，第一阶段实施中；独立工作树 `codex/external-import-20261119`。未部署、未验收。

关联：[ADR-0049 乐观发送](0049-optimistic-send-and-source-reconciliation.md)、[ADR-0051 移动 UI 基线](0051-ui-style-motion-and-visual-stability-freeze.md)、[ADR-0055 Agent 输入生命周期](0055-agent-input-lifecycle-and-state-coverage.md)、[ADR-0064 兼容性](0064-protocol-compatibility.md)、[ADR-0072 会话配置与可恢复启动](0072-session-configuration-and-recoverable-launch.md)、[ADR-0083 反馈等级](0083-feedback-levels-and-stale-replies.md)。

## 背景

其他 App 的文件、文字、链接应能进入 Orbis，既可先留在手机，也可明确交给某台电脑上的已有会话或新建会话。系统入口只授予接收本次内容的权限，不能视为选择会话、上传、启动 Agent 或执行指令的授权。配对、原生权限与 Host—设备端到端加密语义保持不变。

## 决策

### 1. 四个系统入口，共用同一导入语义

| 场景 | 入口 | 行为 |
| --- | --- | --- |
| IMPORT-01 Android 分享 | `ACTION_SEND` / `ACTION_SEND_MULTIPLE`；文字、链接原样接收，文件通过系统授予读权限的 `content://` 流读取 | 打开主 App，显示本次进入的待导入项；冷启动及热交付使用同一路径 |
| IMPORT-02 Android 用其他应用打开 | `ACTION_VIEW` + 可读的 `content://` 文档，按支持类型注册 | 打开主 App；不是网页浏览器，不注册 `http` / `https` 打开入口 |
| IMPORT-03 iOS 分享 | Share Extension（`com.apple.share-services`），通过 `NSItemProvider` 接收文字、URL、图片及文档 | 原生小面板先看内容，再选「存入 Orbis」。保存后回到来源 App。支持直投后，同一面板另有明确的发送操作 |
| IMPORT-04 iOS 用其他应用打开 | `CFBundleDocumentTypes` 声明常见文档类型，按文件 URL 接收 | 直接打开主 App，进入和系统分享相同的收件流程；配对、Live Activity 深链等继续走原路由 |

注册多个入口不代表来源 App 一定暴露该入口。微信、QQ 的「用其他应用打开」如果实际弹的是系统分享面板，则由对应分享入口接收；只提供应用内转发／复制时，保留手动粘贴和「存储到文件」再导入。不接管剪贴板，不为特定来源 App 做私有适配。

### 2. 本地收件与草稿（IMPORT-05）

- 入口先校验、复制本次获准读取的普通文件；不能只存临时 URI 或 `NSItemProvider` 的文件地址。保留原文件名与扩展名，不信任来源路径、长度、MIME 或显示名。文本和链接当正文，不在导入时打开链接、执行命令、解压或解析文档。单次最多 10 个文件、合计最多 100 MiB 文件数据、文字最多 256 KiB；按实际读取字节限制。批次有独立身份，整体成功才可见，失败不留下可发送的半份文件。
- Android 放应用私有、不可备份目录；iOS 扩展与主 App 共用专用 App Group，不共享通知目录或配对凭据。临时目录和已完成批次分离；确认前的临时文件不出现在列表。写盘、复制、清理在后台；收件区上限 16 批、256 MiB，满时提示清理，不静默删除已确认项目。对于中断留下的未提交副本，后续清理。收件内容不进入日志或遥测。
- 主 App 使用低干扰「待导入」入口，系统打开文件后主动展示该批。预览文件名、大小和正文，允许稍后处理或明确删除。加入会话时复用会话目录，明确显示电脑和会话；或进入现有新建页选择电脑、Agent、项目。只加入草稿时，文字追加且不覆盖既有草稿，文件先是本地附件。草稿或待发送记录完整接管后才从收件区移出，重启和重入不得重复添加。尚未配对、离线、取消选择时保留本地项。

### 3. 已有会话与新建会话（IMPORT-06 / IMPORT-07）

- 面板流程为「内容 → 目标 → 可编辑要求 → 发送」。先提供「已有会话」，再提供「新建会话」；不自动选中其他电脑、同名会话或前台会话。不默认键盘、不增加永久解释文案。可记住最近成功目标供快速选择，但必须显示绑定的电脑、会话与项目。选择「存入 Orbis」和点「发送」是不同操作。
- 已有会话凭 `(hostId, sessionId)` 解出当前原生运行时，核对目标仍存在且可恢复。空闲时提交标准消息；忙碌且后端支持时作为 `followUp` 排队，不走 `steer`。不确认、不支持或不可恢复时保留来源，不换目标、不暗中新建。
- 新建会话使用显式选择的 `(hostId, agentKind, cwd)` 与现有配置策略。先将文件绑定到此次操作；Host 确认准确的新会话及配置就绪、全部附件校验通过后，才发首句。重试沿用操作和启动身份；创建结果未知时先查询，不创建第二个会话。分享的文本作为普通消息，不进入 App 的斜杠命令解析。保留原生审批、权限模式和后端排队能力，不为分享绕过它们。
- 主 App 在前台时（Android 两种入口、iOS 文档打开、以及从收件区操作）优先复用原有配对连接、附件传输和 outbox。现有文件选择器会立刻开始上传，不作为「加入草稿」实现：本地附件移交到既有上传队列须等明确发送。对账按目标与操作身份，不能按来源文案匹配。

### 4. iOS 分享扩展直投（IMPORT-08）

分享扩展可以联网，但不通过私有接口唤起主 App，也不假设主 App 已运行。当前 [Relay 路由](../../packages/relay/src/index.ts) 对同一设备的新连接会置换旧连接；扩展不复用主 App socket、长效设备私钥或全量会话目录。用一个独立、可撤销、版本化的 HTTPS 投递入口承载短操作和后台文件上传，现有聊天链路不变。

1. 主 App 在配对链路上协商 `external-import/v1`。只为用户选定的目标授予投递权限：既有会话的稳定 ID 或经确认的 `(Agent, 项目, 配置版本)` 新建预设。扩展只读最小目标清单和 Host 身份，使用短寿命、限目标和限预算的独立授权。设备取消配对、授权过期或撤销后拒绝新投递；Host 在接收和执行前重新确认。授权密钥放专用 Keychain 访问组，不写入 App Group 明文文件。
2. 利用经审查的既有端到端安全模型，为绑定 Host 的投递建立独立加密上下文；目标、正文和文件内容保持密文，Relay 只能校验路由、作用域、限额及生命周期所需信息，不可读会话或文件。命令 ID、不可变目标、文件完整性和过期时间在认证范围内。HTTPS 背景上传使用磁盘文件和扩展专用 session identifier，且只移交密文。Relay 的临时密文有容量、到期和完成清理；第一版不承诺 Host 离线时自动执行，收件区保留可手动重试。
3. 手机侧区分「保存在手机」「正在上传」「等待电脑确认」「已接收／已排队」「失败」；HTTP 收到或上传完成不是 Host 或 Agent 接收。Host 先校验配对、目标、额度、附件与操作指纹，再持久记账；同一操作的重试只返回原结果，回执丢失查询原身份。原生接收未确认时保留真实状态，不把超时当作未执行并重发。后台完成后的回执在主 App 中核对，不依赖扩展一直活着。
4. 新能力按 App、Relay、Host 实际支持独立协商，不能给旧设备发它不认的注册字段。不支持、授权过期或来源仅交付不可读取数据时回到本地保存；新版本不能抢占旧传输连接。第一版直投先落已有会话的文字和附件；新建会话和后台恢复按同一能力分别验收。

平台依据：[Apple Share Extension](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html)、[扩展联网与后台传输](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html)、[打开其他应用的限制（Apple DTS）](https://developer.apple.com/forums/thread/779644)、[iOS 文档类型](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundledocumenttypes)、[Android 接收分享](https://developer.android.com/training/sharing/receive)。

## 分期与验证

| 阶段 | 交付 | 验证边界 |
| --- | --- | --- |
| A：本地入口（IMPORT-01–05 的收件部分） | 四个入口、可靠暂存、可重开的收件列表；不上传、不改 Host 或 Relay | 依据仓库测试规则做定向单测和构建；微信、QQ、系统文件和网页来源由真机确认实际交付，不以菜单出现代替成功 |
| B：主 App 会话投递（IMPORT-05 草稿、IMPORT-06/07） | 加入既有草稿、明确发送、可恢复新建与首句 | 隔离 Host/Relay 与合成会话；验证无提前上传、目标不漂移、请求不重复、失败保留 |
| C：iOS 扩展直投（IMPORT-08） | 能力协商、独立授权、密文后台 HTTP 投递及回执 | 真实已发布旧实现对照、多端连接共存与断线恢复、撤销与到期、签名及 App Group 实机验收 |

### 提交顺序

| Ticket | 范围 | 依赖 |
| --- | --- | --- |
| OI-00 | 决策、平台入口、收件与投递契约 | — |
| OI-01 | Android 分享／打开方式、系统授权内复制、主 App 收件页（IMPORT-01/02/05） | OI-00 |
| OI-02 | iOS 文档打开、主 App 收件页与共享区存储核心（IMPORT-04/05） | OI-00 |
| OI-03 | iOS 分享扩展、入口与签名检查（IMPORT-03） | OI-02 |
| OI-04 | 主 App 选择已有会话、加入草稿、确认发送（IMPORT-05/06） | OI-01/02；iOS 分享入口由 OI-03 接入 |
| OI-05 | 新建会话、附件和首句交接及恢复（IMPORT-07） | OI-04 |
| OI-06 | Host/Relay 独立授权、加密投递与跨版本回退（IMPORT-08） | OI-04 |
| OI-07 | iOS 扩展发送已有会话、后台上传与回执；新建目标按 OI-05 能力接入（IMPORT-08） | OI-03/05/06 |

各提交只包含本 Ticket 的实现、相应测试和证据指针。A 的本地批次与持久化测试、构建和设备验证分别登记；阶段 B/C 不以 A 的结果代替。待真机回归的候选由共享 QA Case 管理，领取后由节点构建；验收以用户记录为准。

### OI-01 实施记录

Android 冷启动／`onNewIntent` 入口、受系统授权的文件流、原子收件箱及可重开预览已实现。入口只入本地存储，不接 Host。源码见 [Intent 接收](../../android/app/src/main/java/com/orbising/orbis/ExternalImportIntent.kt)、[收件存储](../../android/app/src/main/java/com/orbising/orbis/ExternalImportStore.kt)与[平台用例](../../android/app/src/androidTest/java/com/orbising/orbis/ExternalImportIntentTest.kt)。

`ExternalImportStoreTest` 4/4 通过，平台用例已编译、未在设备执行；首轮编译失败及修正后结果分别保存在 [首轮日志](../../.artifacts/external-import/oi-01/run.log)和[自动验证](../../.artifacts/external-import/oi-01-verified/)。
