# 删掉「电脑 → 手机」的主动推送

**Status:** accepted

原有一条与「手机请求型下载」方向相反、由**电脑发起**的传输路径：Pi 进程把文件推给某台已配对
设备（`runtime.push.*` → 中继托管字节 → 设备收 `artifact.push.*` 并回明文 `artifact.ack`）。
本 ADR 决定**整条删除**，而不是把它接通。

## Context

### 它从未接通

链路上缺的是 Host 那一段转发：Pi 扩展把 `runtime.push.started/finished/failed` 发给本机 Host 的
loopback 端点，而 Host 收到这三个消息**直接忽略**（`packages/host/src/loopback-server.ts`，
注释写着"等 M4 接上 Codex backend 之后再有真实发送方"）。中继侧的推送队列、持久化、
窗口推进与手机侧的接收全套都在，但**没有任何一端能发起一次真实推送**。

依赖它的功能也早已停用：`scripts/android-cicd.sh` 只构建 APK，注释里写明"把 APK 推给已配对
手机那一步刻意禁用"；投递用的 `push-android-apk.ps1` + 扩展侧命名管道服务器（`android-ci.ts`）
保留着"以备将来重启"。**（后续清理把它们全部删除了：`scripts/android-cicd.sh`、
`push-android-apk.ps1`、`android-ci.ts` 现在都不在仓库里，Android 的构建也不再走任何 CI——
直接跑 `./android/gradlew.bat -p android assembleDebug`。本仓库的 CI/CD 现在只剩 Relay 的
GitHub Actions 工作流，见 AGENTS.md 的「CI/CD 与 Relay 部署」。）**

### 它与中继的边界冲突

推送必须由中继托管用户的文件字节，并接收设备发来的**明文**进度回执（`artifact.ack`）——
因为只有中继知道自己把窗口推到哪里。也就是说，中继不只是路由，它**持有用户文件**，
并且是唯一一条设备明文命令的接收方。

这与本仓库其余部分刻意维持的边界相反：下载由 Host 就地读盘、以端到端密文分片发出，中继只按
`hdr.to` 路由；命令只存在于 E2E 密文里（ADR-0008 已把设备明文命令面收窄到推送的这两个事实）。
保留推送就等于长期保留一个"中继看得到东西"的例外，而它服务的功能还不存在。

### 代价很小

- **文件取用有替代**：手机要哪个文件就在列表里请求它——Host 就地读盘发送（ADR-0005），
  发起方是手机，不需要电脑主动"推"。
- **APK 投递有替代**：`adb install android/app/build/outputs/apk/debug/app-debug.apk`。
- **没有第二个用户**：与 ADR-0008 同一个前提，删除只影响作者本人的使用方式。

## Decision

删除整条主动推送，包括：

- **协议**：`runtime.push.started/finished/failed`、`artifact.push.available/finished/failed`、
  `artifact.push.ack/rejected`、`artifact.ack`（`RuntimeCommand` 里的那个），以及那条只服务它的
  设备明文命令通道与 `PushProgressCommandSchema`。删掉后，**设备的明文命令通道不复存在**：
  `DeviceClientMessage` 只剩 `device.authenticate` 与 v2 帧，命令只能在 E2E 密文里。
- **中继**：推送队列、状态文件与数据目录（`relay-pushes.json` / `relay-pushes.json.data`）、
  窗口推进与 `pumpPush`、`transferRoutes`、`artifact.push.*` 的转发与 `artifact.ack` 处理、
  相关选项与环境变量。附带结果是**中继不再处理任何原始二进制帧**（推送是它唯一的用途）：
  中继从此是纯 JSON 路由，`MAX_BINARY_BUFFERED_BYTES` 与背压丢帧那套护栏一并删除。
- **Pi extension 侧**：`pushRemoteArtifact` / `pushRemoteFile` / `registerRemoteArtifactPusher`
  这套公开 API，以及依赖它的 `ArtifactTransfer`（`runtime-bridge`）。
  **`registerRemoteArtifact` / `createRemoteArtifactMessage` 保留**——它们服务下载（在聊天里生成
  可点击的下载卡片，手机按 `path` 请求 Host 读盘），与推送无关。
- **Android**：`artifact.push.*` 的接收与任务、`ackPushedArtifact`/`cancelPushedArtifact`
  与那条明文回执、下载列表里区分推送来源的 `pushId`。
- **Android CI 的投递脚手架**：`packages/pi-extension/src/android-ci.ts` 与
  `scripts/windows/push-android-apk.ps1`（`push-android-apk.ps1` 在 CI 里本就处于禁用状态），
  以及扩展配置 `androidCiEnabled` / `androidCiRepositoryRoot`。安装改由 `adb install` 完成。

## Consequences

- 中继上**没有任何用户文件、也没有任何明文命令**；中继可见面只剩认证、路由与设备目录。
- 一条设备命令通道（明文 `runtime.command`）**整条消失**，`DeviceClientMessage` 的明文面
  收窄到 `device.authenticate` + v2 帧——这是一条可以写测试钉住的安全边界。
- 「中继只管路由」这个性质不再有例外，交付路径只剩两条：手机请求下载（电脑 → 手机）
  与手机上传（手机 → 电脑）。
- 需要把电脑上的文件送到手机时，只能由手机发起（`artifact.download` / `file.download` 找 `hostId`）。
- 若将来确实需要电脑主动投递（例如 CI 直接装 APK），要重新设计：以 Host 为发送方、
  走 E2E 分片，才能不把中继拉回"持有用户文件"的位置；不要恢复本文删除的那套中继托管方案。
