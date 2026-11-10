# ADR-0072：会话配置与可恢复的乐观启动

日期：2026-11-10

Status: accepted（主路径已实现；自动验证与后端能力边界见下文；未部署，待用户验证）

关联：ADR-0031、0049、0051、0055、0058、0061、0064、0070。

## 问题

新建卡片只选择 Agent 与工作目录，创建请求不携带模型、思考深度或权限。运行中的配置修改又被通用写操作门禁阻挡，无法提前设置后续请求。进程上线、配置保存和原生配置确认属于不同事实；仅按上线释放首句会使默认配置抢先执行。丢失启动回执后重新创建请求也可能重复创建会话。

## 决策

### 配置作用域与来源

新建卡片显示模型、该模型支持的思考深度和权限摘要，使用现有选择面板。Host 按后端、供应商配置身份与绝对工作目录返回原生默认值、可用选项及已保存偏好。未知、不支持和跟随原生默认分别表示。App 提交不透明选项，Host 校验和原子持久化后返回版本；偏好只影响随后新建的会话。

运行中允许提交当前会话的后续配置。后续所选值、保存进度和原生确认分开处理；运行中显示后续模型，模型变化时重算深度选项。当前请求使用的值由原生请求事实确认。后端能够原生更新时直接调用并核对，后端没有可验证的修改接口时明确显示能力限制。配置修改与历史回退、重载、关闭分别准入。权限按原生实际生效边界确认，单次工具审批保持独立，不能把配置成功当成某次审批的回答。

### 新建时序

1. App 为一次启动建立稳定身份，保存配置快照和首句恢复副本，立即进入聊天页并显示启动中与本地首句。
2. 配置保存与启动按版本建立依赖；Host 在任何原生副作用前持久记录本次启动的设备、身份、参数指纹和不可变配置快照。
3. 优先带配置创建；原生需要会话身份时先创建空会话，登记返回的身份，再应用模型、深度与权限并核对。
4. Host 记录就绪结果并返回精确会话身份及本次配置确认。Runtime 上线可以提前呈现，首句必须等待本次配置确认。App 与 Host 的发送准入共同维护此条件。
5. 首句沿既有消息身份与 outbox 提交，配置失败保留原会话、输入和重试入口。空输入启动使用相同配置确认条件。

### 中断与恢复

配置和启动操作按身份及参数指纹去重。重复请求读取原结果或继续同一操作；同身份异参拒绝。启动操作持久保存原生会话身份及阶段，回执丢失后按启动身份查询。恢复配置使用原生读取或幂等 setter 对同一会话核对并确认；超时表示未确认，不能自动使用默认值或新建另一个会话。原生创建已执行、返回身份尚未持久记录时若无法精确找回，保留未知并阻止自动重建。

App 在写入前保存启动与消息恢复信息，重开后先核对；未确认的消息不自动重发。旧连接或旧配置版本不能释放新操作的依赖。离开启动页后保持后台执行和不拉回页面的既有语义。Host 停止、配置清单变化和供应商切换后重新校验身份及选项。创建前的最终拒绝也持久保存，同身份迟到请求不能在稍后转为新建；App 保留被拒绝首句，重新选择配置前先处理原输入。

### 后端执行

| 后端 | 新建 | 运行中更新及边界 |
| --- | --- | --- |
| Codex 终端／桌面 | `thread/start` 传模型、`config.model_reasoning_effort`、沙箱、审批及处理者；返回有效设置 | `thread/settings/update` 支持活动 turn；模型／深度保留 ADR-0061 的下一轮覆盖和原生逐字段对账；权限等待有效设置确认 |
| DeepSeek Web | 创建空会话，`session/selectModel`，权限原生命令，读取投影 | 原生区分 `modelSelection.lastUsed`／`next`；权限执行并核对投影，实际工具生效边界由原生决定 |
| DeepSeek ACP | 当前版本只在 `session/new` 后返回清单；卡片提示先开空会话，原生会话中选择模型与深度 | 使用 `session/set_config_option` 返回的配置确认；没有权限选项时显示能力限制 |
| Pi | 原生 `--model provider/id`／`--thinking`，上线核对；清单读取保留供应商扩展 | 使用扩展原生 setter；通用沙箱／审批配置不由 Orbis 推断 |
| Claude Code | 原生 `--model`／`--effort`／`--permission-mode`；同参数初始化核对权限，TUI 桥接确认模型及深度选择 | 模型走 `config.set`，深度通过原生 `turn.step` 对下一 turn 应用；当前 turn 保留深度。`config.permissionMode` 只修改启动默认值，当前会话权限维持只读提示 |

### 协议与交互

新增能力独立声明后启用，保持协议 18／19 和旧创建路径。旧 Host 明确显示不支持新建配置；已选择的新功能不能被静默丢弃。用户界面保持乐观呈现与原位失败恢复，权限摘要以确认事实为准。

iOS 仅将带有匹配配置请求身份的协议错误归到配置操作；缺少身份的命令错误继续交由既有命令与关闭账本处理。发版全套回归保留首次失败于 `.artifacts/release-prep-20261110/ios-testflight-first-failure.log`，修复由 `LaunchLedgerTests` 的身份回归及既有 `StoreTests`、`QuitLedgerTests` 验证。

功能 S51／SC73：新建配置、配置确认后的首句放行、运行中后续配置、同身份启动恢复。相关实现及最小充分回归分别记录。

## 验证与完成状态

本机隔离原生验证、初次失败与未完成边界见 `.artifacts/new-session-launch-settings-20261110/verification.json` 及 `runtime-updates/verification.json`。Codex 两类 app-server 活动 turn 更新、Pi RPC 活动请求更新通过；DeepSeek Web 活动 turn 的选择及权限投影已确认，下一次模型请求探针尚有失败，保留原断言。Claude 原生 CLI 启动参数与首个本地请求已核对；隔离 TUI 的 `config.permissionMode` 修改只影响默认值，计划模式的原生 `tool.check` 不变；`settings.read()` 的文件深度与启动深度不同，不能用它确认 `--effort`。深度改为桥接到原生 `turn.step` 并以插件回归确认当前／下一 turn。TUI 探针初次失败与后续有效证据保存在 `implementation/native*`，插件验证见 `implementation/claude-mod-tests-final.log`。

实现、构建、断线／重复／重启自动验证、部署和设备安装验收分别记录；待用户验证。

实现指针：协议 `packages/protocol/src/session-configuration.ts`；Host `session-configuration-store.ts`、`host-service.ts` 及各后端适配器；Android `SessionConfiguration.kt`、`SessionDraft.kt`、`HostConnection.kt`；iOS `Models.swift`、`SessionViews.swift`、`OrbisStore.swift`。S51／SC73 使用基线 r54。

自动验证指针：`implementation/node-final.json`、`final-launch-recovery-2.json`、`swift-final/run.log`、`android-final-2/`、`ios-app-final/`、`claude-model-regression-final.log`。回归源码为 `session-configuration-store.test.ts`、`session-configuration-probe.test.ts`、`host-service.test.ts` 的 configured launch 用例、双端 `LaunchLedger`、`ConfigLedger`、运行时权限用例，以及 Claude 插件 `reconnect.test.ts`。最终计数、源码指纹与构建状态统一见 `implementation/verification.json`。

剩余能力边界：ACP 的新建前清单、Claude 当前会话权限写入、Claude 原生默认模型与深度精确展示，以及 DSH Web 切换后的第二次真实模型请求尚未完成端到端验证。Claude 默认值未报告时显示继承并省略参数，模型清单的 `default` 别名不能替代当前配置。无专属权限接口的 Pi／ACP 保留来源说明。设备安装与视觉验收未执行；本轮不宣称这些边界已通过。
