# 聊天与后台补齐隔离试验结果

日期：2026-11-04（Asia/Taipei）。依据 [ADR-0065 §10](../adr/0065-native-quic-relay-transport.md#10-先隔离当前聊天与后台历史2026-11-04)、[试验方案](native-quic-chat-history-isolation.md)，NQ-13 / R67。工作树 `orbis-native-quic`，基点 `df02972`；主工作树后续 UI / 兼容改动未合并。代码、受控试验、手机现场与发布分别判定。

## 结论

同一两段 QUIC 诊断路径中，将后台补齐从 msg 移到 bulk 后，交互 msg 探针各轮 p95 的中位数从 **6.02 秒降到 0.57 秒**；三轮隔离组分别约 0.569 / 0.504 / 0.616 秒，600 个探针全部返回，没有超过 3 秒的探针。此结果支持“让后台补齐与当前交互独立传输”的方向；它不是实际手机聊天显示或停更故障已经修复的证明。

后台有效字节速率的中位数同时从约 6.82 降至 1.15 Mbit/s，未证明整体吞吐改善，也未通过单变量对照证明下降由优先级独自造成。最终产品试验仅隔离 **catchup**；首屏 preview、手动上翻的 history、实时聊天和目录继续保留 msg，避免把用户当前读取需求当作低优先级后台工作。bulk 暂时与低频文件 / 工具详情共享，不是新增第四条专用流。

## 1. 做了什么

- `relayHistoryMode=shared` 保留原分类；显式 `background` 仅将 Relay 的 catchup snapshot 在封帧前归入 bulk。LAN、默认 WS 和默认 shared 保持；没有安装手机、重启用户 Host 或部署生产服务。
- Host 依据已登记请求的不可变 range 分类；原 E2E nonce / 高水位、piece、同步字节预算、进展回调、SQLite applied 和 ACK 不变。
- QUIC 使用逐 lane 待写量准入，避免一个阻塞的 bulk writer 把 msg 一起挡在 Host；WS 仍按共享 socket backlog。
- 手机淘汰 bulk 中的 JSON 历史 / 详情时报告 session overflow，触发原同步恢复；二进制文件仍按 offset 恢复。
- 文件占满 bulk 时，尚未封帧的后台补齐只返回准入拒绝，不摘除健康聊天路径。该边界的新用例修复前失败、修复后通过，原失败保留。

两段仍共用各自连接的拥塞窗口 / 连接流控。大 preview、本地解码 / 落库、后端 pending 或源基线依赖仍可造成等待；本试验不保证消除这些停顿。

## 2. 公网测量范围

Mac Host → 真正 Relay `45.58.185.226:24443` → 同 Mac Go 参考客户端，两段均经过公网。每端明确核对 WSS/WSS 或 QUIC/QUIC，没有回退；未经过香港生产入口，未使用实际手机或 Hysteria。

独立身份 / TLS 根 / 临时容器，固定同一 IP / 端口 / 镜像；两种 mode 与两种协议按轮次交错。每轮预热 5 秒、测量 20 秒、最多 60 秒排空，3 轮 × 2 mode × 2 协议。原始结果中的 scenario 名为 download，但实际是有界 **256 KiB 历史形状诊断 JSON**，不是文件下载。应用在途预算 4 MiB，保留 E2E、pieces、序号 / 内容验证、应用 ACK、生产 HostRelayClient / helper / Relay。每 100 ms 从 ctl 发出一次请求，Host 通过 msg 回复，用于测量交互数据排队。

诊断使用临时预派生密钥，不覆盖业务握手；诊断 JSON 不是 App 可直接应用的 session.snapshot，也不执行真实 Agent / SQLite / UI。两组都采用修正后的逐 lane 准入，比较变量是后台载荷的 channel / 流归属。手机语义由独立的真 HostService snapshot / ACK 和移动端测试验证，不混为本列结果。

## 3. 正式结果

**12/12** 完整窗口通过，内容 / 序号与排空均完成，**2400/2400** 计划探针返回，无错误窗口。分位数先按每轮 nearest-rank 计算，再取轮次中位数；没有剔除慢探针或把测量窗外才返回的探针删掉。

| 两段承载 | 后台与聊天 | 各轮 p95 中位数 | 各轮 p95 范围 | 超过 3 秒的探针 | 超过 10 秒 | 背景字节中位数 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| WSS/WSS | 同 msg | 19.914 秒 | 2.256–28.576 秒 | 400/600 | 347/600 | 3.67 Mbit/s |
| WSS/WSS | 背景 bulk | 14.926 秒 | 1.820–30.506 秒 | 335/600 | 196/600 | 5.87 Mbit/s |
| QUIC/QUIC | 同 msg | 6.022 秒 | 3.548–29.689 秒 | 466/600 | 165/600 | 6.82 Mbit/s |
| QUIC/QUIC | 背景 bulk | **0.569 秒** | **0.504–0.616 秒** | **0/600** | **0/600** | 1.15 Mbit/s |

以上超时档是“延迟超过阈值的探针数”，不等于独立卡顿事件数。超过 30 秒的探针：WSS 同 msg 为 0，WSS 背景 bulk 为 27，QUIC 同 msg 为 3，QUIC 背景 bulk 为 0。WSS 分组仍出现严重长尾，不能将改 channel 宣称为 WS 也获得原生多流隔离。

### 逐轮 p95

| 轮次 | WSS 同 msg | QUIC 同 msg | WSS 背景 bulk | QUIC 背景 bulk |
| --- | ---: | ---: | ---: | ---: |
| 1 | 28.576 秒 | 29.689 秒 | 1.820 秒 | 0.569 秒 |
| 2 | 2.256 秒 | 3.548 秒 | 14.926 秒 | 0.504 秒 |
| 3 | 19.914 秒 | 6.022 秒 | 30.506 秒 | 0.616 秒 |

QUIC 该列 p95 中位数下降约 90.5%，只描述这一组有背景负载的诊断样本。三轮样本、公网波动、既有测试容器 CPU quota / UDP 接收条件、Mac 同时执行的 iOS 模拟器任务都限制归因；未做独占客户端环境或接收条件 / 拥塞控制器单变量。不能外推“手机聊天普遍快 90.5%”，也不能把背景字节速率降低全部归因于分类。

原始证据：`.artifacts/quic-chat-history/20261104/public-history/` 的 `raw.jsonl`、`history-summary.json`、`host-progress.jsonl`、两端 metrics、`resources.jsonl`、两端候选快照 / hash、`provenance.json`。测量后诊断脚本仅补充 Node 内建对象的显式 import 以通过 lint，已核对与原全局对象身份相同；公网对应的原脚本快照仍保留。最终 Host 策略收窄为 catchup 的回归另列。

## 4. 正确性与回归

<!-- chat-regression-results:start -->
| 验证 | 最终结果 | 证据（均在本轮证据根下） |
| --- | --- | --- |
| Node 默认全量 | 1746 通过、0 失败、5 原跳过，共 1751 项 | `node-all-catchup.json` |
| 最终 catchup 定向 | 74/74 | `catchup-targeted.json` |
| Host / 参考客户端四种 WS/QUIC 组合，background | 每组 92/92，共 368/368；含原业务和真实 snapshot / applied ACK | `matrix-summary-catchup-final.json`、各组原始 JSON |
| Swift 核心 / 实际 Apple QUIC 互通 | 371/371 | `swift/run.log` |
| Android JVM | 694/694 | `core-test-summary.json`、`android-build-jdk21/` |
| Go race | 51 个含子用例测试事件通过，0 失败 / 跳过 | `go-all-final/run.log`、`core-test-summary.json` |
| Android 同设备 full | 基线 170 通过 / 6 失败 / 5 跳过；候选 171 / 6 / 5，增加 JNI 用例通过；无新增失败 / 缺失原用例 | `android-comparison/comparison.json` |
| Android rich / slow-sync | 两版 rich 均 1/1；slow-sync 均 0/2，同样断言 `expected 7 but was 15` | `android-comparison/` |
| iOS SE / iOS 27.0 同设备 A1 原全量 | 两版均 83 通过 / 5 失败 / 0 跳过，共 88 项；全部用例状态相同，五项失败断言及数值相同 | `ios-final-comparison/failure-comparison.json`、两版 summary / tests、`candidate.xcresult` |
| 构建与静态检查 | 双端 App / AndroidTest 包、类型检查及改动代码 lint 通过；Python 汇总测试 8/8 | `android-build-jdk21/`、`ios-build/`、`typescript-catchup/`、`chat-perf-build/` |

Go race 在最终 Host range 收窄前执行，之后 Go 传输核心未改；诊断 Go main 后续单独构建 / 冒烟。Swift / Android 客户端源码与包 hash 在收窄后未变；最终源码 / 包 / 证据 hash 见 `final-provenance.json`，不覆盖早期 `provenance.json`。公网诊断发送脚本显式导入与原全局对象身份、四个核心传输依赖 hash 的核对见 `public-history/post-measurement-verification.json`。

最终四组合首次复跑中，QUIC/WS 出现一次 DeepSeek 按需启动 Abort 超时（91/92），保留 `quic-ws-catchup.json`；随后同目标 shared/background 交错各三次均通过，完整四组合再跑各 92/92。没有改变原断言、超时或生产代码掩盖它，未证明根因或宣称已修复。见 `dsh-rechecks.json` 与最终矩阵。

iOS 五项既有失败涉及 drawer 收起 / 目录更新时滚动位置、长历史工具展开及两个提问定位用例；Android full 六项既有失败涉及权限文本输入、DeepSeek 会话创建显示、两项图标 / 轻压反馈、问卷草稿及 Host 归属，slow-sync 两项另列。完整失败名称 / 断言保留于上述对照文件。iOS 的 xcodebuild 实际退出 65；外层采集驱动退出 0 只表示结果 / 附件采集与设置恢复完成。无新增失败仅表示本轮自动回归未发现新增项，既有失败及未完成门禁仍阻止完整验收。

最终 L0 的 feature ID / 80 项计数、双指南一致和 diff 空白检查通过，18 份相关文档核对 256 个相对链接，无新增坏链。`ui-regression.md` 原有的忽略产物 `20261102-session-sync-rejected/summary.md` 链接在本树缺失，已确认 HEAD 也引用同一路径；保留为既有问题，不记整份文档 L0 全过。见 `final-l0.json`。
<!-- chat-regression-results:end -->

本机受控对照另外证明：暂停历史读取时，三条真实 QUIC 流的 msg / ctl 继续收到；共享 msg 必须先读完 80 个历史帧。恢复读取后全部帧内容 / 顺序校验通过，三轮均通过。该纯传输夹具本身不执行业务 E2E；真实 E2E / 分片 / 版本归属、首屏与手动分页越过后台排队、完整进展回调及路径丢失收尾由 DeviceLink / HostService 用例分别验证。

Android 原全量用例按相同设备与配置对照，并以同一 background 测试夹具补测；客户端包只改消费溢出，最终 Host 策略收窄后包 hash 不变。首次试验也将手动 history 放 bulk，最终仅 catchup；最终 Host 四组合另复跑，设备结果不冒充每个 Host 策略 / 网络组合都跑过完整 UI。

## 5. 验收边界

当前只支持保留为显式试验。实际手机、生产入口、Hysteria 对照、真实 Agent 的首次聊天显示 / 状态同步 / 中断恢复、后台补齐的持续进展、完整 L4 / C01–C18 / A1–A4、既有失败及长期资源门禁均未因此验收。默认模式保持，不能直接发布为新的默认传输或默认同步策略。

Android 抽查了已执行通过的历史 / 重连 / 返回用例所对应截图，发现部分内容 / 行高 / 状态采样差异，另有返回历史截图字节一致；没有据此认定逐像素等价或解释为本改动的因果结果。截图来源与 hash 见 `visual-review/`，完整 L4 仍未完成。

## 6. 资源

公网临时容器、端口、防火墙规则、远端目录、私密配置和本机 benchmark 子进程已独立核验释放。原测试容器 / 生产 Hysteria / 配对数据保持。证据为 `public-history/cleanup.json`、`cleanup-audit.json` 和 `public-history-owner/cleanup.json`。

Android 设备、私有 ADB / emulator、端口及设置已恢复并核验；证据 `android-session/cleanup.json`、`android-cleanup-audit.json`。iOS 编译残留 ibtoold 延迟退出后，已重新核对原身份并释放本任务 DerivedData 租约，保留初次 cleanup-required 与后续 `ios-build/cleanup-audit.json`。同日旧基线的 App 全部文件与 xctestrun hash 已核对，按 UI 回归 §3.2 复用；重复启动的部分基线主动取消并清理，不计作完整结果。见 `ios-baseline-reuse.json`。

<!-- chat-final-cleanup:start -->
iOS 候选与被取消的重复基线均已结束；设备确认 Shutdown、appearance 恢复 light，设备租约释放。候选的 DTServiceHub 延迟退出使初次构建租约清理保留保护，重复基线中断也未留下完整内层 cleanup；核对各原 owner / 已记录子进程退出、构建目录无进程引用及打开文件后，在共享全程 flock / registry 维护互斥内按原 owner 定向释放两个租约。原始不完整记录保留，分别以 `ios-final-comparison/candidate-owner/cleanup-audit.json`、`ios-comparison/baseline-owner/cleanup-audit.json` 和 `final-resource-recovery/cleanup.json` 记录实际恢复。

最终独立审计 `final-cleanup-audit.json` 核对 655 个已记录进程身份均已退出，本任务全部构建租约、设备 / 私有端口 / 维护锁均释放；Android 原端口空闲，iOS 已关闭。共享 `resource_guard.py queue` 返回无 holder、无 blocker。持久 flock 文件保留；没有终止其他任务、删除设备或改动生产服务。
<!-- chat-final-cleanup:end -->
