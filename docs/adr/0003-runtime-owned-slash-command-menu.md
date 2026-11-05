# 使用 Runtime 拥有的统一 Slash 命令菜单

**Status:** accepted

每个 Pi runtime 动态发布一个合并了可远程执行的内置命令、Skill、Prompt Template 和扩展命令的菜单，设备提交结构化 Slash invocation。命令覆盖范围、发现、参数候选项和执行语义只有一个电脑端来源，避免客户端白名单、文本特判与结构化 action 三套机制漂移。依赖 InteractiveMode 私有 TUI 组件、且未暴露等价 Extension API 的内置命令不能假装远程执行，必须等 Pi 提供公共 dispatcher 或 command context 后再加入菜单。

设备配对授予 runtime 发布的命令调用权，不提供通用 Shell、任意进程或包管理入口。供应商选择与权限配置分别遵循 [ADR-0019](0019-host-provider-management.md) 和 [ADR-0031](0031-host-permission-management.md) 的专用契约。
