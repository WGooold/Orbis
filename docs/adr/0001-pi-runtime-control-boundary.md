# Pi Runtime 控制边界

**Status:** superseded by ADR-0002

远程控制提供的是已运行 Pi 进程内部的完整、结构化 runtime 操作控制，而不是直接控制电脑。手机可以通过 Pi 自己的 API 操作对话、队列、agent turn、session、branch、上下文、已配置模型和结构化交互；远程协议禁止原始 Shell、任意文件/进程/包/凭据/trust 通道以及未声明的扩展命令。`runtime.reload` 只有在电脑端配置 allowlist 明确启用时才作为结构化 action 暴露，文件下载也只允许电脑端预先注册的 artifact ID，因此不会接受手机提交的任意路径或为 Runtime 扩大能力边界。由于 Pi 仍可能使用它启动时已有的工具和操作系统权限，需要硬性隔离整台电脑时必须使用受限账户、容器或虚拟机。