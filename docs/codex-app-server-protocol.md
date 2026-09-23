# Codex app-server 协议方法清单

来源：codex-cli 0.154.0 的 JSON schema（v2）。共 87 个客户端请求、1 个客户端通知、68 个服务器通知、10 个服务器请求（需回帧）。

传输：WebSocket（`codex app-server --listen ws://127.0.0.1:<port>`）。帧是不带 `jsonrpc:"2.0"` 的 JSON-RPC：请求 `{id,method,params}`、响应 `{id,result|error}`、通知 `{method,params}`。

握手：`initialize`(clientInfo) → 通知 `initialized`。`thread/turns/list` 等需在 initialize 声明 `capabilities.experimentalApi=true`（官方 TUI 不声明，所以它对旧会话拿不到 turns items）。


---

## 一、客户端 → 服务器请求（ClientRequest）

### `initialize`
_InitializeRequest_

**参数** (`InitializeParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capabilities` | `InitializeCapabilities` / null |  |  |
| `clientInfo` | `ClientInfo` | 是 |  |

> ⚠️ 实测：只传 clientInfo 即可；不需要传 capabilities 也能调大部分方法，但 thread/turns/list 会拒（见下）。

### `thread/start`
_Thread/startRequest_

> NEW APIs

**参数** (`ThreadStartParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `approvalPolicy` | `AskForApproval` / null |  |  |
| `approvalsReviewer` | `ApprovalsReviewer` / null |  | Override where approval requests are routed for review on this thread and subsequent turns. |
| `baseInstructions` | string / null |  |  |
| `config` | object / null |  |  |
| `cwd` | string / null |  |  |
| `developerInstructions` | string / null |  |  |
| `personality` | `Personality` / null |  |  |
| `serviceName` | string / null |  |  |
| `ephemeral` | boolean / null |  |  |
| `sandbox` | `SandboxMode` / null |  |  |
| `serviceTier` | string / null |  |  |
| `model` | string / null |  |  |
| `modelProvider` | string / null |  |  |
| `threadSource` | `ThreadSource` / null |  | Optional client-supplied analytics source classification for this thread. |
| `sessionStartSource` | `ThreadStartSource` / null |  |  |

> ⚠️ 实测：新建 thread。cwd 必填。rollout 首轮 turn 后才落盘（开 TUI attach 要等落盘）。

### `thread/resume`
_Thread/resumeRequest_

**参数** (`ThreadResumeParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `approvalPolicy` | `AskForApproval` / null |  |  |
| `approvalsReviewer` | `ApprovalsReviewer` / null |  | Override where approval requests are routed for review on this thread and subsequent turns. |
| `baseInstructions` | string / null |  |  |
| `config` | object / null |  |  |
| `cwd` | string / null |  |  |
| `developerInstructions` | string / null |  |  |
| `serviceTier` | string / null |  |  |
| `sandbox` | `SandboxMode` / null |  |  |
| `personality` | `Personality` / null |  |  |
| `model` | string / null |  | Configuration overrides for the resumed thread, if any. |
| `modelProvider` | string / null |  |  |
| `threadId` | string | 是 |  |

> ⚠️ 实测：有三种定位：thread_id / history / path。thread_id 标识已运行 thread 时直接 rejoin；非运行时从磁盘加载。**旧格式 rollout resume 只给 turns 骨架（items 全空，itemsView=summary）**——app-server 拿不出 UI items。

### `thread/fork`
_Thread/forkRequest_

**参数** (`ThreadForkParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `approvalPolicy` | `AskForApproval` / null |  |  |
| `approvalsReviewer` | `ApprovalsReviewer` / null |  | Override where approval requests are routed for review on this thread and subsequent turns. |
| `baseInstructions` | string / null |  |  |
| `config` | object / null |  |  |
| `cwd` | string / null |  |  |
| `developerInstructions` | string / null |  |  |
| `ephemeral` | boolean |  |  |
| `threadId` | string | 是 |  |
| `model` | string / null |  | Configuration overrides for the forked thread, if any. |
| `modelProvider` | string / null |  |  |
| `sandbox` | `SandboxMode` / null |  |  |
| `serviceTier` | string / null |  |  |
| `threadSource` | `ThreadSource` / null |  | Optional client-supplied analytics source classification for this forked thread. |

> ⚠️ 实测：从磁盘加载旧 thread fork 成新 thread。但实测新 thread 的 turns.items 也基本全空（fork 迁不动旧 UI items）。

### `thread/archive`
_Thread/archiveRequest_

**参数** (`ThreadArchiveParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/delete`
_Thread/deleteRequest_

**参数** (`ThreadDeleteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/unsubscribe`
_Thread/unsubscribeRequest_

**参数** (`ThreadUnsubscribeParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/name/set`
_Thread/name/setRequest_

**参数** (`ThreadSetNameParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 |  |
| `threadId` | string | 是 |  |

### `thread/goal/set`
_Thread/goal/setRequest_

**参数** (`ThreadGoalSetParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `objective` | string / null |  |  |
| `status` | `ThreadGoalStatus` / null |  |  |
| `threadId` | string | 是 |  |
| `tokenBudget` | integer / null |  |  |

### `thread/goal/get`
_Thread/goal/getRequest_

**参数** (`ThreadGoalGetParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/goal/clear`
_Thread/goal/clearRequest_

**参数** (`ThreadGoalClearParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/metadata/update`
_Thread/metadata/updateRequest_

**参数** (`ThreadMetadataUpdateParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `gitInfo` | `ThreadMetadataGitInfoUpdateParams` / null |  | Patch the stored Git metadata for this thread. Omit a field to leave it unchanged, set it to `null` to clear it, or provide a string to replace the stored va… |
| `threadId` | string | 是 |  |

### `thread/unarchive`
_Thread/unarchiveRequest_

**参数** (`ThreadUnarchiveParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/compact/start`
_Thread/compact/startRequest_

**参数** (`ThreadCompactStartParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

### `thread/shellCommand`
_Thread/shellCommandRequest_

**参数** (`ThreadShellCommandParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | string | 是 | Shell command string evaluated by the thread's configured shell. Unlike `command/exec`, this intentionally preserves shell syntax such as pipes, redirects, a… |
| `threadId` | string | 是 |  |

### `thread/approveGuardianDeniedAction`
_Thread/approveGuardianDeniedActionRequest_

**参数** (`ThreadApproveGuardianDeniedActionParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `event` |  | 是 | Serialized `codex_protocol::protocol::GuardianAssessmentEvent`. |
| `threadId` | string | 是 |  |

### `thread/rollback`
_Thread/rollbackRequest_

**参数** (`ThreadRollbackParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `numTurns` | integer | 是 | The number of turns to drop from the end of the thread. Must be >= 1.  This only modifies the thread's history and does not revert local file changes that ha… |
| `threadId` | string | 是 |  |

### `thread/list`
_Thread/listRequest_

**参数** (`ThreadListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `archived` | boolean / null |  | Optional archived filter; when set to true, only archived threads are returned. If false or null, only non-archived threads are returned. |
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `cwd` | `ThreadListCwdFilter` / null |  | Optional cwd filter or filters; when set, only threads whose session cwd exactly matches one of these paths are returned. |
| `limit` | integer / null |  | Optional page size; defaults to a reasonable server-side value. |
| `modelProviders` | array / null |  | Optional provider filter; when set, only sessions recorded under these providers are returned. When present but empty, includes all providers. |
| `useStateDbOnly` | boolean |  | If true, return from the state DB without scanning JSONL rollouts to repair thread metadata. Omitted or false preserves scan-and-repair behavior. |
| `searchTerm` | string / null |  | Optional substring filter for the extracted thread title. |
| `sortDirection` | `SortDirection` / null |  | Optional sort direction; defaults to descending (newest first). |
| `sortKey` | `ThreadSortKey` / null |  | Optional sort key; defaults to created_at. |
| `sourceKinds` | array / null |  | Optional source filter; when set, only sessions from these source kinds are returned. When omitted or empty, defaults to interactive sources. |

### `thread/loaded/list`
_Thread/loaded/listRequest_

**参数** (`ThreadLoadedListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `limit` | integer / null |  | Optional page size; defaults to no limit. |

> ⚠️ 实测：返回当前 app-server 内存里加载的 thread id 列表（不含磁盘）。

### `thread/read`
_Thread/readRequest_

**参数** (`ThreadReadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `includeTurns` | boolean |  | When true, include turns and their items from rollout history. |
| `threadId` | string | 是 |  |

> ⚠️ 实测：includeTurns=true 也只给 turns 骨架，items 同样空（旧格式）。

### `thread/inject_items`
_Thread/injectItemsRequest_

> Append raw Responses API items to the thread history without starting a user turn.

**参数** (`ThreadInjectItemsParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `items` | array<True> | 是 | Raw Responses API items to append to the thread's model-visible history. |
| `threadId` | string | 是 |  |

> ⚠️ 实测：items 描述为 "Raw Responses API items to append to the thread's model-visible history"——是喂模型上下文的，不是补 UI items view，对修旧会话显示无效。

### `skills/list`
_Skills/listRequest_

**参数** (`SkillsListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwds` | array<string> |  | When empty, defaults to the current session working directory. |
| `forceReload` | boolean |  | When true, bypass the skills cache and re-scan skills from disk. |

### `skills/extraRoots/set`
_Skills/extraRoots/setRequest_

**参数** (`SkillsExtraRootsSetParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `extraRoots` | array<`AbsolutePathBuf`> | 是 |  |

### `hooks/list`
_Hooks/listRequest_

**参数** (`HooksListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwds` | array<string> |  | When empty, defaults to the current session working directory. |

### `marketplace/add`
_Marketplace/addRequest_

**参数** (`MarketplaceAddParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `refName` | string / null |  |  |
| `source` | string | 是 |  |
| `sparsePaths` | array / null |  |  |

### `marketplace/remove`
_Marketplace/removeRequest_

**参数** (`MarketplaceRemoveParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `marketplaceName` | string | 是 |  |

### `marketplace/upgrade`
_Marketplace/upgradeRequest_

**参数** (`MarketplaceUpgradeParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `marketplaceName` | string / null |  |  |

### `plugin/list`
_Plugin/listRequest_

**参数** (`PluginListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwds` | array / null |  | Optional working directories used to discover repo marketplaces. When omitted, only home-scoped marketplaces and the official curated marketplace are conside… |
| `marketplaceKinds` | array / null |  | Optional marketplace kind filter. When omitted, only local marketplaces are queried, plus the default remote catalog when enabled by feature flag. |

### `plugin/installed`
_Plugin/installedRequest_

**参数** (`PluginInstalledParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwds` | array / null |  | Optional working directories used to discover repo marketplaces. |
| `installSuggestionPluginNames` | array / null |  | Additional uninstalled plugin names that should be returned when present locally. This is used by mention surfaces that intentionally expose install entrypoi… |

### `plugin/read`
_Plugin/readRequest_

**参数** (`PluginReadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `marketplacePath` | `AbsolutePathBuf` / null |  |  |
| `pluginName` | string | 是 |  |
| `remoteMarketplaceName` | string / null |  |  |

### `plugin/skill/read`
_Plugin/skill/readRequest_

**参数** (`PluginSkillReadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remoteMarketplaceName` | string | 是 |  |
| `remotePluginId` | string | 是 |  |
| `skillName` | string | 是 |  |

### `plugin/share/save`
_Plugin/share/saveRequest_

**参数** (`PluginShareSaveParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `discoverability` | `PluginShareDiscoverability` / null |  |  |
| `pluginPath` | `AbsolutePathBuf` | 是 |  |
| `remotePluginId` | string / null |  |  |
| `shareTargets` | array / null |  |  |

### `plugin/share/updateTargets`
_Plugin/share/updateTargetsRequest_

**参数** (`PluginShareUpdateTargetsParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `discoverability` | `PluginShareUpdateDiscoverability` | 是 |  |
| `remotePluginId` | string | 是 |  |
| `shareTargets` | array<`PluginShareTarget`> | 是 |  |

### `plugin/share/list`
_Plugin/share/listRequest_

**参数** (`PluginShareListParams`)

_无字段_

### `plugin/share/checkout`
_Plugin/share/checkoutRequest_

**参数** (`PluginShareCheckoutParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remotePluginId` | string | 是 |  |

### `plugin/share/delete`
_Plugin/share/deleteRequest_

**参数** (`PluginShareDeleteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `remotePluginId` | string | 是 |  |

### `app/list`
_App/listRequest_

**参数** (`AppsListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `forceRefetch` | boolean |  | When true, bypass app caches and fetch the latest data from sources. |
| `limit` | integer / null |  | Optional page size; defaults to a reasonable server-side value. |
| `threadId` | string / null |  | Optional thread id used to evaluate app feature gating from that thread's config. |

### `fs/readFile`
_Fs/readFileRequest_

**参数** (`FsReadFileParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` |  | 是 | Absolute path to read. |

### `fs/writeFile`
_Fs/writeFileRequest_

**参数** (`FsWriteFileParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dataBase64` | string | 是 | File contents encoded as base64. |
| `path` |  | 是 | Absolute path to write. |

### `fs/createDirectory`
_Fs/createDirectoryRequest_

**参数** (`FsCreateDirectoryParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` |  | 是 | Absolute directory path to create. |
| `recursive` | boolean / null |  | Whether parent directories should also be created. Defaults to `true`. |

### `fs/getMetadata`
_Fs/getMetadataRequest_

**参数** (`FsGetMetadataParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` |  | 是 | Absolute path to inspect. |

### `fs/readDirectory`
_Fs/readDirectoryRequest_

**参数** (`FsReadDirectoryParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` |  | 是 | Absolute directory path to read. |

### `fs/remove`
_Fs/removeRequest_

**参数** (`FsRemoveParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `force` | boolean / null |  | Whether missing paths should be ignored. Defaults to `true`. |
| `path` |  | 是 | Absolute path to remove. |
| `recursive` | boolean / null |  | Whether directory removal should recurse. Defaults to `true`. |

### `fs/copy`
_Fs/copyRequest_

**参数** (`FsCopyParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `destinationPath` |  | 是 | Absolute destination path. |
| `recursive` | boolean |  | Required for directory copies; ignored for file copies. |
| `sourcePath` |  | 是 | Absolute source path. |

### `fs/watch`
_Fs/watchRequest_

**参数** (`FsWatchParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` |  | 是 | Absolute file or directory path to watch. |
| `watchId` | string | 是 | Connection-scoped watch identifier used for `fs/unwatch` and `fs/changed`. |

### `fs/unwatch`
_Fs/unwatchRequest_

**参数** (`FsUnwatchParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `watchId` | string | 是 | Watch identifier previously provided to `fs/watch`. |

### `skills/config/write`
_Skills/config/writeRequest_

**参数** (`SkillsConfigWriteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `enabled` | boolean | 是 |  |
| `name` | string / null |  | Name-based selector. |
| `path` | `AbsolutePathBuf` / null |  | Path-based selector. |

### `plugin/install`
_Plugin/installRequest_

**参数** (`PluginInstallParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `marketplacePath` | `AbsolutePathBuf` / null |  |  |
| `pluginName` | string | 是 |  |
| `remoteMarketplaceName` | string / null |  |  |

### `plugin/uninstall`
_Plugin/uninstallRequest_

**参数** (`PluginUninstallParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `pluginId` | string | 是 |  |

### `turn/start`
_Turn/startRequest_

**参数** (`TurnStartParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `serviceTier` | string / null |  | Override the service tier for this turn and subsequent turns. |
| `approvalPolicy` | `AskForApproval` / null |  | Override the approval policy for this turn and subsequent turns. |
| `approvalsReviewer` | `ApprovalsReviewer` / null |  | Override where approval requests are routed for review on this turn and subsequent turns. |
| `clientUserMessageId` | string / null |  |  |
| `summary` | `ReasoningSummary` / null |  | Override the reasoning summary for this turn and subsequent turns. |
| `cwd` | string / null |  | Override the working directory for this turn and subsequent turns. |
| `effort` | `ReasoningEffort` / null |  | Override the reasoning effort for this turn and subsequent turns. |
| `threadId` | string | 是 |  |
| `input` | array<`UserInput`> | 是 |  |
| `model` | string / null |  | Override the model for this turn and subsequent turns. |
| `sandboxPolicy` | `SandboxPolicy` / null |  | Override the sandbox policy for this turn and subsequent turns. |
| `outputSchema` |  |  | Optional JSON Schema used to constrain the final assistant message for this turn. |
| `personality` | `Personality` / null |  | Override the personality for this turn and subsequent turns. |

> ⚠️ 实测：input 是 `[{type:"text", text}]` 数组。响应只代表 turn 被接受，结束靠 turn/completed 通知。

### `turn/steer`
_Turn/steerRequest_

**参数** (`TurnSteerParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `clientUserMessageId` | string / null |  |  |
| `expectedTurnId` | string | 是 | Required active turn id precondition. The request fails when it does not match the currently active turn. |
| `input` | array<`UserInput`> | 是 |  |

### `turn/interrupt`
_Turn/interruptRequest_

**参数** (`TurnInterruptParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> ⚠️ 实测：需带 threadId + turnId。host 的 stop 命令映射到这里。

### `review/start`
_Review/startRequest_

**参数** (`ReviewStartParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delivery` | `ReviewDelivery` / null |  | Where to run the review: inline (default) on the current thread or detached on a new thread (returned in `reviewThreadId`). |
| `target` | `ReviewTarget` | 是 |  |
| `threadId` | string | 是 |  |

### `model/list`
_Model/listRequest_

**参数** (`ModelListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `includeHidden` | boolean / null |  | When true, include models that are hidden from the default picker list. |
| `limit` | integer / null |  | Optional page size; defaults to a reasonable server-side value. |

### `modelProvider/capabilities/read`
_ModelProvider/capabilities/readRequest_

**参数** (`ModelProviderCapabilitiesReadParams`)

_无字段_

### `experimentalFeature/list`
_ExperimentalFeature/listRequest_

**参数** (`ExperimentalFeatureListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `limit` | integer / null |  | Optional page size; defaults to a reasonable server-side value. |
| `threadId` | string / null |  | Optional loaded thread id. Pass this when showing feature state for an existing thread so enablement is computed from that thread's refreshed config, includi… |

### `permissionProfile/list`
_PermissionProfile/listRequest_

**参数** (`PermissionProfileListParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `cwd` | string / null |  | Optional working directory to resolve project config layers. |
| `limit` | integer / null |  | Optional page size; defaults to the full result set. |

### `experimentalFeature/enablement/set`
_ExperimentalFeature/enablement/setRequest_

**参数** (`ExperimentalFeatureEnablementSetParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `enablement` | object | 是 | Process-wide runtime feature enablement keyed by canonical feature name.  Only named features are updated. Omitted features are left unchanged. Send an empty… |

### `mcpServer/oauth/login`
_McpServer/oauth/loginRequest_

**参数** (`McpServerOauthLoginParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 |  |
| `scopes` | array / null |  |  |
| `timeoutSecs` | integer / null |  |  |

### `config/mcpServer/reload`
_Config/mcpServer/reloadRequest_

### `mcpServerStatus/list`
_McpServerStatus/listRequest_

**参数** (`ListMcpServerStatusParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cursor` | string / null |  | Opaque pagination cursor returned by a previous call. |
| `detail` | `McpServerStatusDetail` / null |  | Controls how much MCP inventory data to fetch for each server. Defaults to `Full` when omitted. |
| `limit` | integer / null |  | Optional page size; defaults to a server-defined value. |
| `threadId` | string / null |  |  |

### `mcpServer/resource/read`
_McpServer/resource/readRequest_

**参数** (`McpResourceReadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `server` | string | 是 |  |
| `threadId` | string / null |  |  |
| `uri` | string | 是 |  |

### `mcpServer/tool/call`
_McpServer/tool/callRequest_

**参数** (`McpServerToolCallParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `_meta` | any |  | |
| `arguments` | any |  | |
| `server` | string | 是 |  |
| `threadId` | string | 是 |  |
| `tool` | string | 是 |  |

### `windowsSandbox/setupStart`
_WindowsSandbox/setupStartRequest_

**参数** (`WindowsSandboxSetupStartParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | `AbsolutePathBuf` / null |  |  |
| `mode` | `WindowsSandboxSetupMode` | 是 |  |

### `windowsSandbox/readiness`
_WindowsSandbox/readinessRequest_

### `account/login/start`
_Account/login/startRequest_

**参数** (`LoginAccountParams`)

_无字段_

### `account/login/cancel`
_Account/login/cancelRequest_

**参数** (`CancelLoginAccountParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `loginId` | string | 是 |  |

### `account/logout`
_Account/logoutRequest_

### `account/rateLimits/read`
_Account/rateLimits/readRequest_

### `account/rateLimitResetCredit/consume`
_Account/rateLimitResetCredit/consumeRequest_

**参数** (`ConsumeAccountRateLimitResetCreditParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `idempotencyKey` | string | 是 | Identifies one logical reset attempt. A UUID is recommended; reuse the same value when retrying that attempt. |

### `account/usage/read`
_Account/usage/readRequest_

### `account/workspaceMessages/read`
_Account/workspaceMessages/readRequest_

### `account/sendAddCreditsNudgeEmail`
_Account/sendAddCreditsNudgeEmailRequest_

**参数** (`SendAddCreditsNudgeEmailParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `creditType` | `AddCreditsNudgeCreditType` | 是 |  |

### `feedback/upload`
_Feedback/uploadRequest_

**参数** (`FeedbackUploadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `classification` | string | 是 |  |
| `extraLogFiles` | array / null |  |  |
| `includeLogs` | boolean |  |  |
| `reason` | string / null |  |  |
| `tags` | object / null |  |  |
| `threadId` | string / null |  |  |

### `command/exec`
_Command/execRequest_

> Execute a standalone command (argv vector) under the server's sandbox.

**参数** (`CommandExecParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `command` | array<string> | 是 | Command argv vector. Empty arrays are rejected. |
| `cwd` | string / null |  | Optional working directory. Defaults to the server cwd. |
| `disableOutputCap` | boolean |  | Disable stdout/stderr capture truncation for this request.  Cannot be combined with `outputBytesCap`. |
| `disableTimeout` | boolean |  | Disable the timeout entirely for this request.  Cannot be combined with `timeoutMs`. |
| `env` | object / null |  | Optional environment overrides merged into the server-computed environment.  Matching names override inherited values. Set a key to `null` to unset an inheri… |
| `outputBytesCap` | integer / null |  | Optional per-stream stdout/stderr capture cap in bytes.  When omitted, the server default applies. Cannot be combined with `disableOutputCap`. |
| `tty` | boolean |  | Enable PTY mode.  This implies `streamStdin` and `streamStdoutStderr`. |
| `processId` | string / null |  | Optional client-supplied, connection-scoped process id.  Required for `tty`, `streamStdin`, `streamStdoutStderr`, and follow-up `command/exec/write`, `comman… |
| `sandboxPolicy` | `SandboxPolicy` / null |  | Optional sandbox policy for this command.  Uses the same shape as thread/turn execution sandbox configuration and defaults to the user's configured policy wh… |
| `size` | `CommandExecTerminalSize` / null |  | Optional initial PTY size in character cells. Only valid when `tty` is true. |
| `streamStdin` | boolean |  | Allow follow-up `command/exec/write` requests to write stdin bytes.  Requires a client-supplied `processId`. |
| `streamStdoutStderr` | boolean |  | Stream stdout/stderr via `command/exec/outputDelta` notifications.  Streamed bytes are not duplicated into the final response and require a client-supplied `… |
| `timeoutMs` | integer / null |  | Optional timeout in milliseconds.  When omitted, the server default applies. Cannot be combined with `disableTimeout`. |

### `command/exec/write`
_Command/exec/writeRequest_

> Write stdin bytes to a running `command/exec` session or close stdin.

**参数** (`CommandExecWriteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `closeStdin` | boolean |  | Close stdin after writing `deltaBase64`, if present. |
| `deltaBase64` | string / null |  | Optional base64-encoded stdin bytes to write. |
| `processId` | string | 是 | Client-supplied, connection-scoped `processId` from the original `command/exec` request. |

### `command/exec/terminate`
_Command/exec/terminateRequest_

> Terminate a running `command/exec` session by client-supplied `processId`.

**参数** (`CommandExecTerminateParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `processId` | string | 是 | Client-supplied, connection-scoped `processId` from the original `command/exec` request. |

### `command/exec/resize`
_Command/exec/resizeRequest_

> Resize a running PTY-backed `command/exec` session by client-supplied `processId`.

**参数** (`CommandExecResizeParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `processId` | string | 是 | Client-supplied, connection-scoped `processId` from the original `command/exec` request. |
| `size` |  | 是 | New PTY size in character cells. |

### `config/read`
_Config/readRequest_

**参数** (`ConfigReadParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | string / null |  | Optional working directory to resolve project config layers. If specified, return the effective config as seen from that directory (i.e., including any proje… |
| `includeLayers` | boolean |  |  |

### `externalAgentConfig/detect`
_ExternalAgentConfig/detectRequest_

**参数** (`ExternalAgentConfigDetectParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwds` | array / null |  | Zero or more working directories to include for repo-scoped detection. |
| `includeHome` | boolean |  | If true, include detection under the user's home directory. |

### `externalAgentConfig/import`
_ExternalAgentConfig/importRequest_

**参数** (`ExternalAgentConfigImportParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `migrationItems` | array<`ExternalAgentConfigMigrationItem`> | 是 |  |
| `source` | string / null |  | Source product that produced the migration items. Missing means unspecified. |

### `externalAgentConfig/import/readHistories`
_ExternalAgentConfig/import/readHistoriesRequest_

### `config/value/write`
_Config/value/writeRequest_

**参数** (`ConfigValueWriteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `expectedVersion` | string / null |  |  |
| `filePath` | string / null |  | Path to the config file to write; defaults to the user's `config.toml` when omitted. |
| `keyPath` | string | 是 |  |
| `mergeStrategy` | `MergeStrategy` | 是 |  |
| `value` | any | 是 | |

### `config/batchWrite`
_Config/batchWriteRequest_

**参数** (`ConfigBatchWriteParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `edits` | array<`ConfigEdit`> | 是 |  |
| `expectedVersion` | string / null |  |  |
| `filePath` | string / null |  | Path to the config file to write; defaults to the user's `config.toml` when omitted. |
| `reloadUserConfig` | boolean |  | When true, hot-reload the updated user config into all loaded threads after writing. |

### `configRequirements/read`
_ConfigRequirements/readRequest_

### `account/read`
_Account/readRequest_

**参数** (`GetAccountParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `refreshToken` | boolean |  | When `true`, requests a proactive token refresh before returning.  In managed auth mode this triggers the normal refresh-token flow. In external auth mode th… |

### `fuzzyFileSearch`
_FuzzyFileSearchRequest_

**参数** (`FuzzyFileSearchParams`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cancellationToken` | string / null |  |  |
| `query` | string | 是 |  |
| `roots` | array<string> | 是 |  |


---

## 二、客户端 → 服务器通知（ClientNotification）

### `initialized`
_InitializedNotification_

> 客户端→服务器通知（无 id，无需响应）。


---

## 三、服务器 → 客户端通知（ServerNotification）

### `error`
_ErrorNotification_

> NEW NOTIFICATIONS

**参数** (`ErrorNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | `TurnError` | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |
| `willRetry` | boolean | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/started`
_Thread/startedNotification_

**参数** (`ThreadStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `thread` | `Thread` | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/status/changed`
_Thread/status/changedNotification_

**参数** (`ThreadStatusChangedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | `ThreadStatus` | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

> ⚠️ 实测：通知：thread 状态变（idle/running/...）。host 据此更新 runtime.status。

### `thread/archived`
_Thread/archivedNotification_

**参数** (`ThreadArchivedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/deleted`
_Thread/deletedNotification_

**参数** (`ThreadDeletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/unarchived`
_Thread/unarchivedNotification_

**参数** (`ThreadUnarchivedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/closed`
_Thread/closedNotification_

**参数** (`ThreadClosedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

> ⚠️ 实测：通知：thread 关闭。**但实测：客户端（TUI）断开连接时服务器不广播此通知**——不能靠它检测 TUI 关窗。

### `skills/changed`
_Skills/changedNotification_

**参数** (`SkillsChangedNotification`)

_无字段_

> 服务器→客户端通知（无 id）。

### `thread/name/updated`
_Thread/name/updatedNotification_

**参数** (`ThreadNameUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `threadName` | string / null |  |  |

> 服务器→客户端通知（无 id）。

### `thread/goal/updated`
_Thread/goal/updatedNotification_

**参数** (`ThreadGoalUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `goal` | `ThreadGoal` | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string / null |  |  |

> 服务器→客户端通知（无 id）。

### `thread/goal/cleared`
_Thread/goal/clearedNotification_

**参数** (`ThreadGoalClearedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/settings/updated`
_Thread/settings/updatedNotification_

**参数** (`ThreadSettingsUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `threadSettings` | `ThreadSettings` | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/tokenUsage/updated`
_Thread/tokenUsage/updatedNotification_

**参数** (`ThreadTokenUsageUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `tokenUsage` | `ThreadTokenUsage` | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `turn/started`
_Turn/startedNotification_

**参数** (`TurnStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `turn` | `Turn` | 是 |  |

> 服务器→客户端通知（无 id）。

### `hook/started`
_Hook/startedNotification_

**参数** (`HookStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `run` | `HookRunSummary` | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string / null |  |  |

> 服务器→客户端通知（无 id）。

### `turn/completed`
_Turn/completedNotification_

**参数** (`TurnCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `turn` | `Turn` | 是 |  |

> 服务器→客户端通知（无 id）。

### `hook/completed`
_Hook/completedNotification_

**参数** (`HookCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `run` | `HookRunSummary` | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string / null |  |  |

> 服务器→客户端通知（无 id）。

### `turn/diff/updated`
_Turn/diff/updatedNotification_

**参数** (`TurnDiffUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `diff` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `turn/plan/updated`
_Turn/plan/updatedNotification_

**参数** (`TurnPlanUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `explanation` | string / null |  |  |
| `plan` | array<`TurnPlanStep`> | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/started`
_Item/startedNotification_

**参数** (`ItemStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `item` | `ThreadItem` | 是 |  |
| `startedAtMs` | integer | 是 | Unix timestamp (in milliseconds) when this item lifecycle started. |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/autoApprovalReview/started`
_Item/autoApprovalReview/startedNotification_

**参数** (`ItemGuardianApprovalReviewStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `GuardianApprovalReviewAction` | 是 |  |
| `review` | `GuardianApprovalReview` | 是 |  |
| `reviewId` | string | 是 | Stable identifier for this review. |
| `startedAtMs` | integer | 是 | Unix timestamp (in milliseconds) when this review started. |
| `targetItemId` | string / null |  | Identifier for the reviewed item or tool call when one exists.  In most cases, one review maps to one target item. The exceptions are - execve reviews, where… |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/autoApprovalReview/completed`
_Item/autoApprovalReview/completedNotification_

**参数** (`ItemGuardianApprovalReviewCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | `GuardianApprovalReviewAction` | 是 |  |
| `completedAtMs` | integer | 是 | Unix timestamp (in milliseconds) when this review completed. |
| `decisionSource` | `AutoReviewDecisionSource` | 是 |  |
| `review` | `GuardianApprovalReview` | 是 |  |
| `reviewId` | string | 是 | Stable identifier for this review. |
| `startedAtMs` | integer | 是 | Unix timestamp (in milliseconds) when this review started. |
| `targetItemId` | string / null |  | Identifier for the reviewed item or tool call when one exists.  In most cases, one review maps to one target item. The exceptions are - execve reviews, where… |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/completed`
_Item/completedNotification_

**参数** (`ItemCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `completedAtMs` | integer | 是 | Unix timestamp (in milliseconds) when this item lifecycle completed. |
| `item` | `ThreadItem` | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

> ⚠️ 实测：通知：item 完成时发，payload.item 带 type/id/content。新版 item.type 是 camelCase（agentMessage/userMessage/reasoning/commandExecution/fileChange/mcpToolCall…）。

### `item/agentMessage/delta`
_Item/agentMessage/deltaNotification_

**参数** (`AgentMessageDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

> ⚠️ 实测：通知：流式增量文本。host 据此 message.started+message.delta。

### `item/plan/delta`
_Item/plan/deltaNotification_

> EXPERIMENTAL - proposed plan streaming deltas for plan items.

**参数** (`PlanDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `command/exec/outputDelta`
_Command/exec/outputDeltaNotification_

> Stream base64-encoded stdout/stderr chunks for a running `command/exec` session.

**参数** (`CommandExecOutputDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capReached` | boolean | 是 | `true` on the final streamed chunk for a stream when `outputBytesCap` truncated later output on that stream. |
| `deltaBase64` | string | 是 | Base64-encoded output bytes. |
| `processId` | string | 是 | Client-supplied, connection-scoped `processId` from the original `command/exec` request. |
| `stream` |  | 是 | Output stream for this chunk. |

> 服务器→客户端通知（无 id）。

### `process/outputDelta`
_Process/outputDeltaNotification_

> Stream base64-encoded stdout/stderr chunks for a running `process/spawn` session.

**参数** (`ProcessOutputDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capReached` | boolean | 是 | True on the final streamed chunk for this stream when output was truncated by `outputBytesCap`. |
| `deltaBase64` | string | 是 | Base64-encoded output bytes. |
| `processHandle` | string | 是 | Client-supplied, connection-scoped `processHandle` from `process/spawn`. |
| `stream` |  | 是 | Output stream this chunk belongs to. |

> 服务器→客户端通知（无 id）。

### `process/exited`
_Process/exitedNotification_

> Final exit notification for a `process/spawn` session.

**参数** (`ProcessExitedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `exitCode` | integer | 是 | Process exit code. |
| `processHandle` | string | 是 | Client-supplied, connection-scoped `processHandle` from `process/spawn`. |
| `stderr` | string | 是 | Buffered stderr capture.  Empty when stderr was streamed via `process/outputDelta`. |
| `stderrCapReached` | boolean | 是 | Whether stderr reached `outputBytesCap`.  In streaming mode, stderr is empty and cap state is also reported on the final stderr `process/outputDelta` notific… |
| `stdout` | string | 是 | Buffered stdout capture.  Empty when stdout was streamed via `process/outputDelta`. |
| `stdoutCapReached` | boolean | 是 | Whether stdout reached `outputBytesCap`.  In streaming mode, stdout is empty and cap state is also reported on the final stdout `process/outputDelta` notific… |

> 服务器→客户端通知（无 id）。

### `item/commandExecution/outputDelta`
_Item/commandExecution/outputDeltaNotification_

**参数** (`CommandExecutionOutputDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/commandExecution/terminalInteraction`
_Item/commandExecution/terminalInteractionNotification_

**参数** (`TerminalInteractionNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `itemId` | string | 是 |  |
| `processId` | string | 是 |  |
| `stdin` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/fileChange/outputDelta`
_Item/fileChange/outputDeltaNotification_

> Deprecated legacy apply_patch output stream notification.

**参数** (`FileChangeOutputDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/fileChange/patchUpdated`
_Item/fileChange/patchUpdatedNotification_

**参数** (`FileChangePatchUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `changes` | array<`FileUpdateChange`> | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `serverRequest/resolved`
_ServerRequest/resolvedNotification_

**参数** (`ServerRequestResolvedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `requestId` | `RequestId` | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/mcpToolCall/progress`
_Item/mcpToolCall/progressNotification_

**参数** (`McpToolCallProgressNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `itemId` | string | 是 |  |
| `message` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `mcpServer/oauthLogin/completed`
_McpServer/oauthLogin/completedNotification_

**参数** (`McpServerOauthLoginCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string / null |  |  |
| `name` | string | 是 |  |
| `success` | boolean | 是 |  |

> 服务器→客户端通知（无 id）。

### `mcpServer/startupStatus/updated`
_McpServer/startupStatus/updatedNotification_

**参数** (`McpServerStatusUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string / null |  |  |
| `name` | string | 是 |  |
| `status` | `McpServerStartupState` | 是 |  |
| `threadId` | string / null |  |  |

> 服务器→客户端通知（无 id）。

### `account/updated`
_Account/updatedNotification_

**参数** (`AccountUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `authMode` | `AuthMode` / null |  |  |
| `planType` | `PlanType` / null |  |  |

> 服务器→客户端通知（无 id）。

### `account/rateLimits/updated`
_Account/rateLimits/updatedNotification_

**参数** (`AccountRateLimitsUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `rateLimits` | `RateLimitSnapshot` | 是 |  |

> 服务器→客户端通知（无 id）。

### `app/list/updated`
_App/list/updatedNotification_

**参数** (`AppListUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `data` | array<`AppInfo`> | 是 |  |

> 服务器→客户端通知（无 id）。

### `remoteControl/status/changed`
_RemoteControl/status/changedNotification_

**参数** (`RemoteControlStatusChangedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `environmentId` | string / null |  |  |
| `installationId` | string | 是 |  |
| `serverName` | string | 是 |  |
| `status` | `RemoteControlConnectionStatus` | 是 |  |

> 服务器→客户端通知（无 id）。

### `externalAgentConfig/import/progress`
_ExternalAgentConfig/import/progressNotification_

**参数** (`ExternalAgentConfigImportProgressNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `importId` | string | 是 |  |
| `itemTypeResults` | array<`ExternalAgentConfigImportTypeResult`> | 是 |  |

> 服务器→客户端通知（无 id）。

### `externalAgentConfig/import/completed`
_ExternalAgentConfig/import/completedNotification_

**参数** (`ExternalAgentConfigImportCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `importId` | string | 是 |  |
| `itemTypeResults` | array<`ExternalAgentConfigImportTypeResult`> | 是 |  |

> 服务器→客户端通知（无 id）。

### `fs/changed`
_Fs/changedNotification_

**参数** (`FsChangedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `changedPaths` | array<`AbsolutePathBuf`> | 是 | File or directory paths associated with this event. |
| `watchId` | string | 是 | Watch identifier previously provided to `fs/watch`. |

> 服务器→客户端通知（无 id）。

### `item/reasoning/summaryTextDelta`
_Item/reasoning/summaryTextDeltaNotification_

**参数** (`ReasoningSummaryTextDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `summaryIndex` | integer | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/reasoning/summaryPartAdded`
_Item/reasoning/summaryPartAddedNotification_

**参数** (`ReasoningSummaryPartAddedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `itemId` | string | 是 |  |
| `summaryIndex` | integer | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `item/reasoning/textDelta`
_Item/reasoning/textDeltaNotification_

**参数** (`ReasoningTextDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contentIndex` | integer | 是 |  |
| `delta` | string | 是 |  |
| `itemId` | string | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/compacted`
_Thread/compactedNotification_

> Deprecated: Use `ContextCompaction` item type instead.

**参数** (`ContextCompactedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `model/rerouted`
_Model/reroutedNotification_

**参数** (`ModelReroutedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fromModel` | string | 是 |  |
| `reason` | `ModelRerouteReason` | 是 |  |
| `threadId` | string | 是 |  |
| `toModel` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `model/verification`
_Model/verificationNotification_

**参数** (`ModelVerificationNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |
| `verifications` | array<`ModelVerification`> | 是 |  |

> 服务器→客户端通知（无 id）。

### `turn/moderationMetadata`
_Turn/moderationMetadataNotification_

**参数** (`TurnModerationMetadataNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `metadata` | any | 是 | |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `model/safetyBuffering/updated`
_Model/safetyBuffering/updatedNotification_

**参数** (`ModelSafetyBufferingUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fasterModel` | string / null |  |  |
| `model` | string | 是 |  |
| `reasons` | array<string> | 是 |  |
| `showBufferingUi` | boolean | 是 |  |
| `threadId` | string | 是 |  |
| `turnId` | string | 是 |  |
| `useCases` | array<string> | 是 |  |

> 服务器→客户端通知（无 id）。

### `warning`
_WarningNotification_

**参数** (`WarningNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string | 是 | Concise warning message for the user. |
| `threadId` | string / null |  | Optional thread target when the warning applies to a specific thread. |

> 服务器→客户端通知（无 id）。

### `guardianWarning`
_GuardianWarningNotification_

**参数** (`GuardianWarningNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string | 是 | Concise guardian warning message for the user. |
| `threadId` | string | 是 | Thread target for the guardian warning. |

> 服务器→客户端通知（无 id）。

### `deprecationNotice`
_DeprecationNoticeNotification_

**参数** (`DeprecationNoticeNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `details` | string / null |  | Optional extra guidance, such as migration steps or rationale. |
| `summary` | string | 是 | Concise summary of what is deprecated. |

> 服务器→客户端通知（无 id）。

### `configWarning`
_ConfigWarningNotification_

**参数** (`ConfigWarningNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `details` | string / null |  | Optional extra guidance or error details. |
| `path` | string / null |  | Optional path to the config file that triggered the warning. |
| `range` | `TextRange` / null |  | Optional range for the error location inside the config file. |
| `summary` | string | 是 | Concise summary of the warning. |

> 服务器→客户端通知（无 id）。

### `fuzzyFileSearch/sessionUpdated`
_FuzzyFileSearch/sessionUpdatedNotification_

**参数** (`FuzzyFileSearchSessionUpdatedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | array<`FuzzyFileSearchResult`> | 是 |  |
| `query` | string | 是 |  |
| `sessionId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `fuzzyFileSearch/sessionCompleted`
_FuzzyFileSearch/sessionCompletedNotification_

**参数** (`FuzzyFileSearchSessionCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sessionId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/started`
_Thread/realtime/startedNotification_

**参数** (`ThreadRealtimeStartedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `realtimeSessionId` | string / null |  |  |
| `threadId` | string | 是 |  |
| `version` | `RealtimeConversationVersion` | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/itemAdded`
_Thread/realtime/itemAddedNotification_

**参数** (`ThreadRealtimeItemAddedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `item` | any | 是 | |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/transcript/delta`
_Thread/realtime/transcript/deltaNotification_

**参数** (`ThreadRealtimeTranscriptDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `delta` | string | 是 | Live transcript delta from the realtime event. |
| `role` | string | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/transcript/done`
_Thread/realtime/transcript/doneNotification_

**参数** (`ThreadRealtimeTranscriptDoneNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `role` | string | 是 |  |
| `text` | string | 是 | Final complete text for the transcript part. |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/outputAudio/delta`
_Thread/realtime/outputAudio/deltaNotification_

**参数** (`ThreadRealtimeOutputAudioDeltaNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `audio` | `ThreadRealtimeAudioChunk` | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/sdp`
_Thread/realtime/sdpNotification_

**参数** (`ThreadRealtimeSdpNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sdp` | string | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/error`
_Thread/realtime/errorNotification_

**参数** (`ThreadRealtimeErrorNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `message` | string | 是 |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `thread/realtime/closed`
_Thread/realtime/closedNotification_

**参数** (`ThreadRealtimeClosedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `reason` | string / null |  |  |
| `threadId` | string | 是 |  |

> 服务器→客户端通知（无 id）。

### `windows/worldWritableWarning`
_Windows/worldWritableWarningNotification_

> Notifies the user of world-writable directories on Windows, which cannot be protected by the sandbox.

**参数** (`WindowsWorldWritableWarningNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `extraCount` | integer | 是 |  |
| `failedScan` | boolean | 是 |  |
| `samplePaths` | array<string> | 是 |  |

> 服务器→客户端通知（无 id）。

### `windowsSandbox/setupCompleted`
_WindowsSandbox/setupCompletedNotification_

**参数** (`WindowsSandboxSetupCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string / null |  |  |
| `mode` | `WindowsSandboxSetupMode` | 是 |  |
| `success` | boolean | 是 |  |

> 服务器→客户端通知（无 id）。

### `account/login/completed`
_Account/login/completedNotification_

**参数** (`AccountLoginCompletedNotification`)

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `error` | string / null |  |  |
| `loginId` | string / null |  |  |
| `success` | boolean | 是 |  |

> 服务器→客户端通知（无 id）。


---

## 四、服务器 → 客户端请求（ServerRequest，需回响应帧）

### `item/commandExecution/requestApproval`
_Item/commandExecution/requestApprovalRequest_

> NEW APIs Sent when approval is requested for a specific command execution. This request is used for Turns started via turn/start.

**参数** (`CommandExecutionRequestApprovalParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

> ⚠️ 实测：服务端请求：命令执行需审批。host 映射成 interaction.request；超时回 decline 防挂死。

### `item/fileChange/requestApproval`
_Item/fileChange/requestApprovalRequest_

> Sent when approval is requested for a specific file change. This request is used for Turns started via turn/start.

**参数** (`FileChangeRequestApprovalParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

> ⚠️ 实测：服务端请求：文件改动需审批。同上。

### `item/tool/requestUserInput`
_Item/tool/requestUserInputRequest_

> EXPERIMENTAL - Request input from the user for a tool call.

**参数** (`ToolRequestUserInputParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `mcpServer/elicitation/request`
_McpServer/elicitation/requestRequest_

> Request input for an MCP server elicitation.

**参数** (`McpServerElicitationRequestParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `item/permissions/requestApproval`
_Item/permissions/requestApprovalRequest_

> Request approval for additional permissions from the user.

**参数** (`PermissionsRequestApprovalParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `item/tool/call`
_Item/tool/callRequest_

> Execute a dynamic tool call on the client.

**参数** (`DynamicToolCallParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `account/chatgptAuthTokens/refresh`
_Account/chatgptAuthTokens/refreshRequest_

**参数** (`ChatgptAuthTokensRefreshParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `attestation/generate`
_Attestation/generateRequest_

> Generate a fresh upstream attestation result on demand.

**参数** (`AttestationGenerateParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `applyPatchApproval`
_ApplyPatchApprovalRequest_

> DEPRECATED APIs below Request to approve a patch. This request is used for Turns started via the legacy APIs (i.e. SendUserTurn, SendUserMessage).

**参数** (`ApplyPatchApprovalParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。

### `execCommandApproval`
_ExecCommandApprovalRequest_

> Request to exec a command. This request is used for Turns started via the legacy APIs (i.e. SendUserTurn, SendUserMessage).

**参数** (`ExecCommandApprovalParams`)

_无字段_

> 服务端发来、需回响应帧（带原 id）。
