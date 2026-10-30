# ADR-0050：仅保留 LAN / Relay，固定局域网优先

日期：2026-10-30

Status: accepted（代码实施与本机验证完成；发布验收待执行）

关联：[ADR-0008](0008-drop-backward-compatibility.md)、[ADR-0015](0015-relay-website-and-operator-console.md)、[ADR-0017](0017-public-orbis-release-and-deployment.md)、[ADR-0030](0030-multi-host-mobile-connections.md)、[ADR-0032](0032-host-owned-agent-state-model.md)。

## Context

连接契约需要统一为清晰、稳定的两种路径：局域网直连与中继。设置页的连接排序及逐 Host 下发会增加设备间行为差异，产品决定采用固定选路规则。

本次决定约束协议、Host、Android、iOS、桌面显示、配置、依赖、构建和部署文档，避免各端提供不同的连接契约。

## Decision

### 1. 仅支持 LAN 与 Relay

Host ↔ Device 的 Path 集合为 `lan | relay`。Host 连接摘要只发布这两种路径，最多两条。

优先级固定为 `["lan", "relay"]`，不提供用户或配置覆盖入口。Host 从已完成握手且可用的路径中选择 LAN，否则使用 Relay，并通过 `device.path` 通知设备；RTT 仅用于展示。

- LAN 未就绪时可先使用 Relay；LAN 就绪后立即切换至 LAN。
- LAN 中断时回落到可用的 Relay；LAN 恢复后立即切回。
- Relay 中断时，已有效的 LAN 继续使用；两条路径均不可用时显示离线。
- 每台 Host 的连接、加密会话、状态、重连和传输任务独立。

Relay 连接成功与端到端可用分别判断。现有发现与配对流程继续适用，本决定不新增离线配对或跨网段发现保证。

### 2. 完全删除可配置的优先级

删除 Android、iOS 设置页的排序入口、状态与事件，以及偏好存储、归一化、保存、握手后重发和多 Host 广播逻辑。

Host 不保存设备偏好，不暴露动态排序接口。旧安装保存的值停止读取和写回，不迁移为两项偏好；旧值即使是 Relay 优先，升级后仍固定 LAN 优先。无需清 App 数据或重新配对。

删除 `device.pathPreference` 的生产、解析、分派和设备偏好表。未知控制载荷按通用未知载荷处理，不能影响选路；非法路径公告不得改变当前状态或被映射为其他有效路径。

### 3. 保留共同传输契约

保留 DeviceLink、Envelope、E2E 握手、重放保护、分道序号、切片、背压和有界收发队列。
路径切换不重置配对信任、Session 身份、同步事务或文件持久化进度；失败与恢复遵守既有规则。

Relay 只转发不透明密文，Agent backend 与本机 loopback 的职责不变。管理台停用与撤销仅控制 Relay，不自动撤销 Host 配对或终止 LAN。

配置只保留实际使用的连接字段。已失效字段不再读取，保存时不再写回；保留 Relay 地址、LAN 端口、凭据与身份，不重建配对存储。

依赖、锁文件、项目引用、分发清单、许可证声明与实际产物保持一致。删除不再参与 LAN / Relay 的专用实现、依赖、配置与脚本，不保留隐藏开关或空实现。

### 4. 统一协议版本与发布

遵守 ADR-0008，协议由基线版本 15 统一升至 16。Android、iOS、Relay、Host、本机 runtime / bridge、夹具和探测入口同步使用共享版本；后续集成若另有协议升版，以合并后的共享版本统一构建。

旧端在认证或握手阶段收到可操作的升级提示。Relay 与 LAN 均执行精确版本校验，不支持混合版本互通。

先备齐同版 Host、移动端和本机 runtime 产物，安排切换窗口，再按部署流程先更新 Relay、随后更新各端。发布说明明确混合版本期间连接不可用。

保留身份与配对材料，升级后重新握手；无需重建 Session、清历史缓存或重新配对。回滚使用协议一致的一组产物。线上网络设施调整另行记录。

## Consequences

连接与故障矩阵统一为 LAN / Relay。无可用 LAN 时，远程业务依赖 Relay；Relay 不可用且 LAN 不可达时无法远程连接。

Relay 的带宽成本、延迟、并发与文件吞吐需要实际验证；不得用放宽队列上限掩盖容量不足。安装包体积、构建耗时和耗电变化以实测为准。

## Verification

| 场景 | 验收要求 |
| --- | --- |
| 无可用 LAN | 直接建立 Relay E2E，启动、交互与重连正常 |
| 两条路径可用 | 始终选择 LAN；先连 Relay 后连 LAN 也会切换；Host 公告与手机出站路径一致 |
| 路径故障与恢复 | LAN 断开回落 Relay、恢复切回；Relay 故障不误伤有效 LAN；两路均断开才离线 |
| 旧设置与非法载荷 | 旧排序不再读取、下发或生效；未知控制和非法路径不能改变选路；两种入口均拒绝不匹配版本 |
| 聊天、同步与文件 | 序号、重放保护、队列边界、去重、同步事务和持久化续传规则保持；无跨 Host 污染 |
| 两端设置及连接显示 | 没有排序入口和保存逻辑；仅显示实际 LAN / Relay 状态；管理边界准确 |
| 构建、升级与发布 | 三端构建通过，依赖与包内容一致；配对、身份与用户数据保留；同版切换及 Relay 容量验证有记录 |

设备和网络验收遵守[隔离测试说明](../testing/isolated-host/README.md)，使用隔离状态与合成会话。

## 实施与验证记录

2026-10-30，代码在独立 worktree 完成，实施基线为 `aa6dd8b`。原工作区同步本 ADR 和索引，实现保留在 worktree 供审阅，尚未合并或发布。

已完成：两路径协议与连接摘要、固定选路、设置及全部下游偏好逻辑删除、依赖及项目引用清理、配置与部署文档更新。三端统一协议 16。仓库文档、历史 ADR、审计报告和预览图统一使用 LAN / Relay；非法输入测试使用通用不支持路径与控制载荷。

| 范围 | 已有验证结果与边界 |
| --- | --- |
| Node | 构建、类型检查和 lint 通过；可移植套件 137 个文件、1377 项通过、5 项跳过；包括加密 LAN / Relay 传输、故障恢复和未知控制不改变选路 |
| 最终协议复核 | 连接摘要收紧至两条后，协议、HostService 和 HostState facts 共 63 项再次通过 |
| Android | 479 项单测通过，无失败或跳过；Debug APK 构建通过；lint 为 0 错误、15 警告；非法路径公告不改变生效路径 |
| iOS | 173 项核心测试、15 个 suite 通过；包含隔离 localhost Relay / LAN、重连、双 Host 与加密文件传输；Simulator Debug 构建和包内运行时依赖检查通过 |
| iOS 设置页 | 1 项 UI 回归通过，截图确认没有排序控件，供应商入口与切换流程正常 |
| 运行包与产物 | Host 打包 Node v22.23.2 及 50 个运行依赖；包内 Node 加载协议 16 并验证两路径约束；Host 运行包、Android APK 和 iOS 应用包的依赖清单与文件检查通过 |

文档统一后重新执行定向回归：Node 协议 / HostService 59 项、Android LAN 2 项、iOS Store 54 项通过，修改的 TypeScript 文件 lint 通过。
架构报告的 6 个页面、36 个模块详情、筛选、源码展开、Escape 关闭和桌面 / 手机横向布局检查通过，重新生成并复核 3 张预览图，无脚本错误或外部网络请求。

Android lint 同时修复基线 `StreamingText.kt` 的字体常量组合：改用等价的 `BOLD_ITALIC` / `BOLD` / `ITALIC` / `NORMAL` 分支，字体行为保持。

本机 Node 全量测试有 11 项 Windows 平台假设失败，涉及 `codex-shim.test.ts`、`desktop-terminal.test.ts`、`sessions.test.ts`、`spawner.test.ts` 和 `packages/pi-extension/src/runtime-log.test.ts`。
上述 1377 项为排除这五个文件后的可移植套件，不代表 Windows 全量套件通过。日志、截图、lint 报告与包审计保存在 worktree 已忽略的本地构建产物目录。

发布前仍需执行 Windows 全量测试、Windows / macOS 原生安装包和正式签名移动产物验证、Android 设置页仪器测试、真机覆盖升级与实际网络故障切换、Relay 容量验证及生产版本切换。

生产 Host / Relay、真实会话与配对数据均未修改。代码实施和线上发布分别验收。
