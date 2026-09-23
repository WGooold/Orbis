# 向已配对设备开放 Pi 命令和文件下载

**Status:** accepted；自由 Pi 命令输入通道由 ADR-0003 取代；手机请求型下载的传输机制由 ADR-0005 取代

已配对设备可以调用 runtime 当前发布的 Pi Slash 命令，并可按电脑路径下载 runtime 账户可读取的任意普通文件；远程层不再在 Android 维护命令 allowlist，也不按路径、文件类型或文件大小维护 capability allowlist。选择这一边界是为了先保证远程端功能完整，权限细分留给后续配置；代价是设备凭据现在同时代表 Pi Slash 调用权和 runtime 账户的文件读取权，因此配对认证、设备撤销、TLS 以及操作系统账户/容器隔离仍然保留。

这项决定不开放手机启动或管理 Pi 进程、文件上传或编辑、凭据写入、包管理、trust 修改和通用网络转发。文件下载使用 protocol v3：控制消息保持 JSON，文件内容使用带 `runtimeId`、独立 `transferId`、offset 和长度的二进制 WebSocket 帧；单帧最大 1 MiB。**手机请求型下载的传输机制（窗口 / ACK / 重传）由 [ADR-0005](./0005-receiver-driven-range-download.md) 规定，本 ADR 不再展开。** artifact 元数据携带 SHA-256，Android 在发布文件前校验摘要；手机请求型下载不由 Relay 持久化。Pi 可通过 `pushRemoteFile`/`pushRemoteArtifact` 主动推送给指定设备；只有这类推送由 Relay 持久化元数据、文件前缀和 ACK offset，并在设备上线后继续投递。**（该推送已在 [ADR-0009](./0009-remove-computer-to-phone-push.md) 中整条删除。）**分块大小、文件名净化、偏移、摘要与总长度校验属于传输正确性和 Android 保存要求，不是文件 capability 限制。
