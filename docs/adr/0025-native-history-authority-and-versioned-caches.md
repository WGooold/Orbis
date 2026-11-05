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

原生历史决定当前事实，adapter 确定性映射经过来源核对的完整历史。缓存差异通过 epoch 隔离，纯追加通过 seq 推进；来源与结构验证决定 ready 状态。

### 2. APP 信任 Host 的已验证状态，版本决定写入资格

APP 按归属、范围、结构和 source 版本接受 Host 状态；完整恢复基线激活缓存 epoch，行版本裁决迟到页面。内存与 SQLite 共享校验，并在同一事务更新历史、timing、cursor、coverage 与代次。

### 3. 范围与事务提交

每页声明 source 与实际范围，preview 提供当前 head / live checkpoint，history / catchup 补充已接受代次的缓存。原生重建按代次使旧范围失效，完整事务提交后发布投影。

## Consequences

漏掉 revert 后，原生核对能够修复缓存，不再被旧 conflict 锁死。仍需 ADR-0024 的周期核对、丢包恢复和背压；只删相等检查不能获得这些保证。GUI/TUI 刷新继续由 ADR-0023 处理。

最小方案复用 source epoch，所以 revert、原生修正或 adapter 重启切换 epoch 后，旧缓存范围失效，祖先需要重新加载。旧分支永久留存不属于本次保证；如要跨代次留存，应另行明确归档职责，不能让旧图裁决当前事实。

初次实施时 SQLite 升至版本 7，新增缓存 epoch 和行 seq，保留 v5/v6 迁移记录；协议 10 引入历史页 source 所有权。当前协议演进遵循 ADR-0064，不再要求各端同时升级。本地代码和测试不代表部署完成。

## Verification

[测试规则](../../AGENTS.md#测试)；[OrbisUITests.swift](../../ios/Orbis/UITests/OrbisUITests.swift)；[orbis](../../android/app/src/androidTest/java/com/orbising/orbis)；[原始证据](../../.artifacts/)。

## 实施验证（2026-10-10）

- Windows Node typecheck、lint 和 workspace build 通过，83 个测试文件中的 814 项测试通过。
- Android 单测 353 项通过；独立模拟器上的 SQLite 设备测试 30 项通过，包含缓存 epoch 切换、parent 修正后的 coverage、旧页隔离、事务回滚和 checkpoint 加缓冲 patch 的持久化/投影一致性。
- 独立真实 Codex app-server 双客户端实验覆盖正常通知、慢读取、漏 revert 通知和延迟处理 revert 通知。四种情况下核对后的 Entries 均与重新读取的原生历史逐项一致；漏通知时错误的 6 节点旧图能够恢复为正确的 4 节点历史。
- 上述结果不代表用户正在使用的 Host/APP/Relay 已升级，也不替代升级后的手机与真实桌面 GUI 手动验收。实验未对用户会话执行 revert。
