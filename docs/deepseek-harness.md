# DeepSeek Harness 接入

Orbis 的 `dsh` 后端默认接入官方 Web 会话：Host 连接本机 `dsh web`，手机和浏览器通过同一 Session 共享实时事件。旧 ACP 适配仍保留用于兼容测试和旧嵌入入口，不会自动回退。Windows 桌面与 Android 都提供 DeepSeek 入口；Pi、Codex 和 DSH 可以同时启用。

## 已验证版本与资料

2026-09-24 在 Windows Node.js 22.23.2 上验证了 `@deepseek-ai/dsh@0.1.7-rc.1`。查询时 npm 的 `next` 指向这个版本，`latest` 仍为 `0.1.5-rc.3`；不要用无版本的重装命令把已有安装降级。DSH 要求 Node.js 22.19+ 或受支持的更高版本。

本次适配对照官方 GitHub tag `dsh-v0.1.7-rc.1`（`46a7f68b0922371ce7144b668b90e377d8e799f4`）：

- [ACP 兼容开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/acp/acp/README.md)：旧适配层的会话、取消、模型选项、权限与生命周期。
- [CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/apps/cli/reference/README.md)：profile、配置层与启动方式。
- [持久化 API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/session/session-persistence-jsonl/README.md)：只读 handle 与版本化日志。
- [官方 ACP 兼容 profile](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/bundle/acp-app/cordis.patch.yml) 和 [开发环境](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/docs/development.md)。

## 启用

已有 dsh 时先运行 `dsh --version`。尚未安装时，桌面 Agent 页可安装已验证版本，或在 Windows PowerShell 执行：

```powershell
npm install -g @deepseek-ai/dsh@0.1.7-rc.1
```

Windows 桌面使用步骤：

1. 在 Agent 页重新检测，确认出现 DeepSeek Harness。
2. 暂停 Host，在设置中勾选「启动 Host 时启用 DeepSeek Harness」，保存后重新连接。
3. Android 连接同一 Host 后，选择「新建会话 → DeepSeek」，选择电脑上的工作目录。
4. 使用会话的 `/model` 菜单选择模型；当前模型声明推理档位时，再使用 `/thinking` 菜单切换档位。使用 `/quit` 归档这个会话并保留历史。

CLI Host 在仓库构建后启动：

```powershell
npm run build
node packages/host/dist/cli.js host --dsh
# 同时启用 Codex：
node packages/host/dist/cli.js host --codex --dsh
```

保持原有 Host 配对、Relay 与凭据配置。桌面与 CLI Host 不要同时占用同一个 Host 身份。开发配对脚本也接受 `node scripts/host-pair.mjs --dsh`。

Orbis 自动查找 npm 安装的 `@deepseek-ai/dsh/lib/bin.js`，使用 Windows Node 直接运行，不通过 shell 拼接手机参数。自动检测失败时，在桌面设置中填写该 JavaScript 入口的绝对路径，或为 CLI 设置 `ORBIS_DSH_ENTRY`。

## 本机模型配置

DSH 的模型凭据仍由本机 dsh 管理。可以使用已有凭据配置或 Host 进程继承的 `DEEPSEEK_API_KEY`；不需要把 API key 填到 Android，也不要写入 Orbis 仓库。

Harness home 默认是 `~/.dsh`，可用 `DSH_HOME` 覆盖。Orbis 默认连接 `web` profile；已有 Web 服务可在桌面设置中填写完整的 loopback 启动链接（含 `?token=`），否则 Host 会按 descriptor 复用或启动自己的 Web 服务。home 级 `$DSH_HOME/cordis.patch.yml` 会在 profile 后应用；同一行的 `config` 是整体替换，不是字段深合并。供应商切换等待 DSH 原生热更新加载补丁，并通过本机 credentials API 更新凭据。正在运行任务或等待审批时先结束任务；原生只读环境变量覆盖凭据时会拒绝切换并回滚，需自行调整 Web 启动环境。

如果需要给 Web 固定默认模型，可在 `$DSH_HOME/cordis.patch.yml` 或 Web profile 的 patch 中配置已安装 provider 实际支持的模型。桌面供应商表单会写入共享 `agent-default-model`，旧 `acp` 行仅为兼容保留：

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

桌面「打开 DeepSeek Harness」打开 Host 使用的同一个 `dsh web` 工作台。Orbis 会复用已有的 loopback Web 服务；没有时在 `127.0.0.1` 启动持久服务并保存带 token 的 descriptor。Host 断开不会关闭 Web 服务，浏览器可继续使用；手机需要 Host 恢复在线后才能重新接回同一会话。Web 的模型选择、消息、实时流和队列操作会同步给所有客户端。

Web runtime 不读取本地 sessions 目录作为会话来源；会话目录和历史由 Web RPC（`session/list`、`session/page`、`session/follow`）提供。`$DSH_HOME/sessions` 以及 `ORBIS_DSH_SESSIONS_ROOT` 只供旧 ACP 兼容运行时读取；设置该变量只改变 Orbis 的历史读取位置，不会改写 dsh profile。仍使用 ACP 适配时，Orbis 从所选 CLI 安装位置加载同版本持久化库，并以只读 handle 读取日志。

## 能力与边界

支持会话目录、新建、恢复、独立关闭、文本请求、实时 assistant stream、工具生命周期、共享工具审批、停止、模型与推理档位选择、skills slash 命令，以及 preview/history/catchup 同步。普通消息进入 Web queue，`delivery: "steer"` 会插入当前 turn，`delivery: "followUp"` 会排队；排队消息可撤回。Web runtime 不设置活跃会话数量上限，实际数量受 dsh Web 服务和本机资源限制；用 `/quit` 归档当前会话。

- Host 不拥有 Web 服务的浏览器生命周期，只持有认证连接；多个客户端通过同一个官方 Web 服务读写 Session，不直接写日志。
- Web follow 同时回放 durable event 和 assistant stream，断线后会自动重开订阅并从 Web snapshot 恢复。
- 历史来自 dsh Web 的 durable event/page 数据；会话和 runtime 路由均使用 `dsh:<原始 session ID>`，Entry ID 使用原始事件 `seq`。历史不会用本次读取时间重新生成时间戳。
- 上传附件沿用 Orbis 文件传输，向模型提供电脑上的文件路径；当前不把上传图片自动转换为 dsh Web 图像内容块，历史中的图像/文件块显示提示文本。
- 审批展示工具名及参数，批准只对应一次请求，五分钟未回答自动取消。停止、关闭会话或后端断线会取消待审批请求；不会自动批准工具。
- 支持归档、fork、Steer、Follow-up、队列撤回和 Web skills；未识别的 dsh slash 命令仍会拒绝。审批采用 Orbis 共享 interaction，先响应的客户端获胜。
- 同一活跃会话中的 `messageId` 重试不会重复执行；这份回执不跨 Host 重启。重启后先同步历史确认发送结果，避免盲目重发不确定请求。
- Web transport 的请求超时只结束该 RPC；连接断开后会自动重连并恢复各会话的 follow/snapshot。Host 退出不会关闭 dsh Web 服务，浏览器仍可继续使用，手机需等待 Host 重新连接；`/quit` 只归档指定会话。
- Web 会话目录使用 dsh 返回的 session 元数据；未激活的会话不会预读完整历史，消息数会在激活并同步 `session/page` 后准确。归档和取消归档通过 Web RPC 完成，Host 不维护独立的历史目录。

## 验证

使用 Windows 工具链；先构建，再跑测试，避免清理 `dist` 与运行时测试并发：

```powershell
npm run build
npm run typecheck
npm run lint
npm test
node scripts/test-dsh.mjs
```

`node scripts/test-dsh-web.mjs` 调用已安装的真实 dsh，但创建独立临时 `DSH_HOME` 和工作目录，模型请求仅发往本机回环测试服务，不消费真实 API 额度。它验证 Web URL/token、双客户端同会话 follow、实时 token/tool 流、队列撤回、session cancel、工具 round-trip，以及同一进程中供应商 URL/API Key 切换后的真实请求。测试不会修改用户已有 dsh 会话或凭据。

Host 单元测试另外覆盖旧 ACP 兼容层的分包、超时、无效帧、停止竞态、加密命令路由，以及 Web runtime 的审批会话归属和有界历史同步。Android 的 `DshIdentityTest` 验证品牌和缓存身份，`DshInstrumentedTest` 验证新建入口与审批操作。Android 构建、安装与模拟器使用遵守仓库规定的 Windows 脚本和资源锁。

功能启用前应同步更新桌面 Host 与 Android。正式发布的 Protocol/Relay 构建仍通过 `main` 的 Relay deploy 工作流，不使用本机部署入口。
