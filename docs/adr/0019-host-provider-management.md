# ADR-0019: Host-owned provider management

Date: 2026-09-24

Status: accepted

2026-10-30：供应商管理扩展至 Claude Code 原生 `settings.json`；配对设备和桌面 Host 可按当前官方配置查询 Claude/Codex 的 5 小时与周订阅配额。查询仅返回标准化百分比和重置时间，凭据仍由 Host 保管。

2026-10-13：[ADR-0032](0032-host-owned-agent-state-model.md) 将供应商服务纳入 Host 统一状态模型，并扩展手机可同步的非秘密用量、健康度、认证与路由摘要。配置/凭据权威、事务和手机操作权限边界继续有效；该扩展尚待实现。

## Context

Host manages Agent installation and provider profiles. Paired clients select saved profiles; native-file switching follows the CC Switch model.

A paired device may select a provider profile that the computer's Host has already saved. It does not receive a generic configuration, credential, package or process endpoint.

## Decision

Host owns the provider catalog, credentials, verified Agent installations and transactional native configuration writes. Paired clients select saved profiles through E2E and receive a non-secret projection.

Native profile behavior follows each backend:
- Codex saves and restores provider-owned `auth.json` / `config.toml`, preserving shared preferences and MCP.
- Pi manages explicit nodes in `models.json.providers`.
- DSH applies the home-level `cordis.patch.yml` through native HMR and synchronizes credentials through the local Web API.

Switches validate native availability and active work, commit after confirmed reload, and roll back on failure. Managed OAuth credentials remain in the Host account store, with native rotations adopted by identity and timestamp.

Codex local routing uses an authenticated loopback Responses endpoint with immutable per-request provider snapshots. It supports Responses passthrough and Chat Completions / Anthropic conversion. Explicit failover applies to eligible profiles before streamed output; official Codex OAuth stays on its native route. Disabling routing restores saved native configuration while preserving unrelated edits.
