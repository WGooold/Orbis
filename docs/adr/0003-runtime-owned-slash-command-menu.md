# 使用 Runtime 拥有的统一 Slash 命令菜单

**Status:** accepted

已配对设备不再把自由输入的 `/...` 作为 Pi 命令文本发送，也不再使用独立的 Runtime Action 菜单；每个 Pi runtime 动态发布一个合并了可远程执行的内置命令、Skill、Prompt Template 和扩展命令的菜单，Android 只能从该菜单选择并提交结构化 Slash invocation。这个决定细化了 ADR-0002 的“开放 Pi 命令”通道：命令覆盖范围仍由 Pi runtime 决定，但发现、参数候选项和执行语义只有一个电脑端来源，避免 Android 白名单、文本特判与结构化 action 三套机制漂移。代价是依赖 InteractiveMode 私有 TUI 组件、且未暴露等价 Extension API 的内置命令不能假装远程执行，必须等 Pi 提供公共 dispatcher 或 command context 后再加入菜单。
