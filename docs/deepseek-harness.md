# DeepSeek Harness 接入

Orbis 的 `dsh` 后端使用官方 ACP v1，通过 Host 拥有的 `dsh --profile acp` 子进程驱动会话。Windows 桌面与 Android 都提供 DeepSeek 入口；Pi、Codex 和 DSH 可以同时启用。

## 已验证版本与资料

2026-09-24 在 Windows Node.js 22.23.2 上验证了 `@deepseek-ai/dsh@0.1.7-rc.1`。查询时 npm 的 `next` 指向这个版本，`latest` 仍为 `0.1.5-rc.3`；不要用无版本的重装命令把已有安装降级。DSH 要求 Node.js 22.19+ 或受支持的更高版本。

本次适配对照官方 GitHub tag `dsh-v0.1.7-rc.1`（`46a7f68b0922371ce7144b668b90e377d8e799f4`）：

- [ACP 开发文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/acp/acp/README.md)：会话、取消、模型选项、权限与生命周期。
- [CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/apps/cli/reference/README.md)：profile、配置层与启动方式。
- [持久化 API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/session/session-persistence-jsonl/README.md)：只读 handle 与版本化日志。
- [官方 ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/packages/bundle/acp-app/cordis.patch.yml) 和 [开发环境](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.1/docs/development.md)。

## 启用

已有 dsh 时先运行 `dsh --version`。尚未安装时，桌面 Agent 页可安装已验证版本，或在 Windows PowerShell 执行：

```powershell
npm install -g @deepseek-ai/dsh@0.1.7-rc.1
```

Windows 桌面使用步骤：

1. 在 Agent 页重新检测，确认出现 DeepSeek Harness。
2. 暂停 Host，在设置中勾选「启动 Host 时启用 DeepSeek Harness」，保存后重新连接。
3. Android 连接同一 Host 后，选择「新建会话 → DeepSeek」，选择电脑上的工作目录。
4. 使用会话的 `/model`、`/thinking` 菜单切换官方公布的选项；使用 `/quit` 关闭这个会话并保留历史。

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

Harness home 默认是 `~/.dsh`，可用 `DSH_HOME` 覆盖。Orbis 启动的是 `acp` profile，其配置位于 `$DSH_HOME/profiles/acp/cordis.patch.yml`。home 级 `$DSH_HOME/cordis.patch.yml` 会在 profile 后应用；同一行的 `config` 是整体替换，不是字段深合并。修改后重启 Host。

如果需要给 ACP 固定默认模型，可在该 profile 的 patch 中配置已安装 provider 实际支持的模型，例如已验证发行版自带的默认路由：

```yaml
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```

桌面「打开 DeepSeek Harness」启动官方 `dsh web`。Web 与 ACP 的 profile 配置独立；Web 的模型选择不会自动变成 ACP 的默认模型。共享 home 中的凭据仍由 dsh 按其规则读取。

默认历史根目录是 `$DSH_HOME/sessions`。如果自定义了 ACP 的持久化目录，应同时设置 `ORBIS_DSH_SESSIONS_ROOT` 指向同一目录；这个变量只改变 Orbis 的历史读取位置，不会替 dsh 改写 profile。Orbis 从所选 CLI 的安装位置加载同版本持久化库，并以只读 handle 读取日志。

## 能力与边界

支持会话目录、新建、恢复、独立关闭、文本请求、工具生命周期、一次性工具审批、停止、模型/推理选项、上下文用量，以及 preview/history/catchup 同步。一个 Host 最多保持 8 个活跃 DSH 会话；用 `/quit` 释放会话名额。

- 会话为后台 ACP 会话，不接管外部 Web 或终端中正在运行的 dsh 会话。恢复已有会话前，先关闭其它写入者；不绕过官方持久化锁。
- ACP 发送已提交的 assistant 消息和 reasoning 块，不提供原始逐 token 流。模型仍在生成时，手机可能等到该条消息提交后才显示输出。
- 历史来自持久化日志；会话和 runtime 路由均使用 `dsh:<原始 session ID>`，Entry ID 使用原始事件 `seq`。历史不会用本次读取时间重新生成时间戳。
- 上传附件沿用 Orbis 文件传输，向模型提供电脑上的文件路径；当前不把上传图片自动转换为 ACP 图像 prompt，历史中的图像/文件块显示提示文本。
- 审批展示工具名及参数，批准只对应一次请求，五分钟未回答自动取消。停止、关闭会话或后端断线会取消待审批请求；不会自动批准工具。
- 不支持归档、fork、插话、排队、任意 dsh slash 命令、专有 Web 卡片或交互式 elicitation。手机菜单只公布可执行的 `/model`、`/thinking`、`/quit`。
- 同一活跃会话中的 `messageId` 重试不会重复执行；这份回执不跨 Host 重启。重启后先同步历史确认发送结果，避免盲目重发不确定请求。
- ACP 变更请求超时会取消请求并关闭该连接，避免迟到的会话脱离 Host 管理。其它 DSH 会话也会离线，重启 Host 后可恢复；正常 `/quit` 只关闭指定会话。
- 冷历史目录的修改时间使用创建时间，消息数在会话激活读取后才准确；官方 ACP 目录不提供完整统计。

## 验证

使用 Windows 工具链；先构建，再跑测试，避免清理 `dist` 与运行时测试并发：

```powershell
npm run build
npm run typecheck
npm run lint
npm test
node scripts/test-dsh.mjs
```

最后一个脚本调用已安装的真实 dsh，但创建独立临时 `DSH_HOME` 和工作目录，模型请求仅发往本机回环测试服务，不消费真实 API 额度。它验证中文输出、模型/推理选项、多个会话、真实文件工具、一次性审批、停止、关闭、进程重启、恢复与 canonical Entry 一致性。测试不会修改用户已有 dsh 会话或凭据；终端会输出临时诊断目录。

Host 单元测试另外覆盖 ACP 分包、超时、无效帧、停止竞态、激活并发上限、加密命令路由、审批会话归属与有界历史同步。Android 的 `DshIdentityTest` 验证品牌和缓存身份，`DshInstrumentedTest` 验证新建入口与审批操作。Android 构建、安装与模拟器使用遵守仓库规定的 Windows 脚本和资源锁。

功能启用前应同步更新桌面 Host 与 Android。正式发布的 Protocol/Relay 构建仍通过 `main` 的 Relay deploy 工作流，不使用本机部署入口。
