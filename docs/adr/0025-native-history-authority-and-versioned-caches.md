# ADR-0025：原生历史权威与版本化缓存

日期：2026-10-10

Status: accepted

关联：[ADR-0013](0013-bounded-session-sync-and-shared-tree-ingestion.md)、[ADR-0023](0023-codex-revert-and-client-refresh.md)、[ADR-0024](0024-recoverable-session-state-sync.md)。实施跟踪：[Issue #1](https://github.com/WGooold/Orbis/issues/1)、[Issue #2](https://github.com/WGooold/Orbis/issues/2)。

本决定替代上述 ADR 中“同 ID 与旧缓存不一致必须拒绝，换 epoch 也不能修正”的条款；保留确定性映射、请求归属、范围声明、结构校验和事务要求。首阶段实施对象为 Codex 的版本化同步路径，Pi/DSH 的原生 tree/fork 语义及未版本化路径不变。

## Context

原有实现能够从 `thread/turns/list(itemsView=full)` 重建正确历史，却再与旧内存比较同 ID 的 parent/data。发现不同即报 `canonical_entry_conflict` 并恢复旧图。APP SQLite 和内存 graph 也会拒绝同 ID 的变化。因此错误的旧缓存能永久阻止正确的权威状态恢复。

独立双客户端故障注入验证：原历史为 A→B→R；原生编辑回退后为 A→C→D。若 adapter 漏处理 revert 通知，实时 C 可能先接到 R。随后原生核对正确得到 C 的 parent=A，却被旧缓存的 parent=R 否决。这个复现说明规则存在问题，不证明所有历史故障都来自漏通知；同一健康 WebSocket 的正常顺序不是任意乱序。

不新增 Host 聊天数据库。需要改变权威与缓存的关系，并让版本检查覆盖持久化之前，而不仅是画面更新。

## Decision

### 1. 原生历史决定事实，旧缓存只用于发现失效

Codex 原生保留历史是当前历史的权威。adapter 从完整原生 turns 的顺序、item ID 和内容确定性生成 Entries；旧 parent/order 不参与生成。通过协调代次、通知缓冲及多页一致性核验的重建结果可以修正旧表示，旧缓存不能否决它。

旧图比较只判断缓存代次是否失效：共享 Entry 变化、顺序修正或旧尾部删除时建立新 epoch，先发布 unknown 边界，再发布 ready 状态。纯追加保持 epoch，推进 seq。已进入新 epoch 的 revert 不重复建立代次。实时通知重复 ID 却内容不同时触发原生重读，不猜测覆盖，也不留下永久 conflict。

原生读取失败、不完整或过期时不发布 ready；非法重复节点等结构错误仍失败。full turns hydrate、确定性时间占位、工具规范化及旧格式 fallback 边界继续有效。原生无法恢复的 live 内容仍按 ADR-0024 声明不完整。

### 2. APP 信任 Host 的已验证状态，版本决定写入资格

复用 `source.epoch/seq/ready`，不增加另一套历史 revision。APP 写 SQLite 前执行与 reducer 相同的检查：连接、设备、Runtime、Session、请求、范围、分支代次、retired epoch 和 checkpoint 完整性。

不同 epoch 的 ready patch 不能激活缓存；unknown 只隔离旧画面并请求 checkpoint。经恢复握手接受的完整 ready preview 才能激活新缓存 epoch。在一笔事务中清除该 Session 的旧 Entries、timing、cursor 与 coverage，再写本次有界页；空历史也提交 epoch 和空缓存。既有迁移诊断记录、配对数据和其他 Session 不受影响。

同 epoch 的有效权威结果可以更新同 ID 的 parent/type/timestamp/data。每个 Entry 和 timing 保存已接受 seq；迟到页可以补缺失节点，却不能覆盖较新版本的节点。内存和 SQLite 使用相同规则。未来 patch 先有界缓冲，连续版本或 checkpoint 恢复后一起入库，不提前改变当前缓存。

这里信任的是通过归属、版本、范围和结构验证的 Host 结果，不采用“最后到达者获胜”。

### 3. 覆盖范围与提交必须明确

所有版本化页面携带 source；只有 preview 带当前 head/live checkpoint。history/catchup 只能补当前已接受 epoch 的缓存，不能切换 epoch、head 或运行态。页外缺席不表示删除。

完整原生重建通过新 epoch 使旧范围失效；一个 30 条 preview 仍只是有界范围，祖先按需重新加载。禁止自环、可证明的 parent 循环、同一 packet 内不同内容的重复 ID。parent 修正时，已有 verified depth 和连续覆盖在同一事务失效并重新推导。

Entry、版本、timing、cursor、coverage 和 epoch 激活在一笔 SQLite 事务提交。失败整批回滚，不能出现新 epoch 配旧图；提交后才发布投影。重启读取持久化的缓存代次和行版本，不靠进程内 seq 推断磁盘归属。

## Consequences

漏掉 revert 后，原生核对能够修复缓存，不再被旧 conflict 锁死。仍需 ADR-0024 的周期核对、丢包恢复和背压；只删相等检查不能获得这些保证。GUI/TUI 刷新继续由 ADR-0023 处理。

最小方案复用 source epoch，所以 revert、原生修正或 adapter 重启切换 epoch 后，旧缓存范围失效，祖先需要重新加载。旧分支永久留存不属于本次保证；如要跨代次留存，应另行明确归档职责，不能让旧图裁决当前事实。

SQLite 升级到版本 7，新增缓存 epoch 和行 seq，保留 v5/v6 迁移记录。协议升级到版本 10：历史页新增 source 所有权，缓存契约改变。按 ADR-0008 拒绝新旧混跑并提示更新；Host、APP、Relay、Pi extension 需协调升级。本地代码和测试不代表部署完成。

## Verification

- 正常、遗漏及延迟 revert 通知后，原生核对得到相同 parent、正文与 head；纯追加不触发全缓存失效。
- 新 epoch checkpoint 修正同 ID 并原子替换旧缓存；unknown、未握手 ready patch、retired 页和过期读取不能改写磁盘或画面。
- 同 epoch 迟到页只补缺口，不覆盖较新节点；局部页不删除页外节点，不切换 head/live。
- 重挂 parent 后 coverage 重算；非法重复、自环、跨缓存循环及失去归属时，epoch/cursor/coverage 一起回滚。
- checkpoint 与连续缓冲 patch 的 canonical 提交保持持久化与投影一致；重启加载行版本后仍能拒绝旧数据。

## 实施验证（2026-10-10）

- Windows Node typecheck、lint 和 workspace build 通过，83 个测试文件中的 814 项测试通过。
- Android 单测 353 项通过；独立模拟器上的 SQLite 设备测试 30 项通过，包含缓存 epoch 切换、parent 修正后的 coverage、旧页隔离、事务回滚和 checkpoint 加缓冲 patch 的持久化/投影一致性。
- 独立真实 Codex app-server 双客户端实验覆盖正常通知、慢读取、漏 revert 通知和延迟处理 revert 通知。四种情况下核对后的 Entries 均与重新读取的原生历史逐项一致；漏通知时错误的 6 节点旧图能够恢复为正确的 4 节点历史。
- 上述结果不代表用户正在使用的 Host/APP/Relay 已升级，也不替代升级后的手机与真实桌面 GUI 手动验收。实验未对用户会话执行 revert。
