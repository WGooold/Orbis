# `@pi-remote/interaction-sdk`

供 Pi 第三方扩展使用的可移植交互接口。扩展业务逻辑继续在电脑端运行，SDK 把声明式交互同步给本地 Pi UI 和 Android 原生 renderer，并负责校验和 Promise 生命周期。

目前支持：

- `confirm`：确认/拒绝，可设置按钮文案、工具名称和参数摘要。
- `select`：单选，支持选项标签和说明。
- `multiSelect`：多选，支持最少/最多选择数量。
- `questionnaire`：整份问卷一次提交，支持每题单选/多选、Other、补充说明、切题修改、草稿恢复与取消。
- `input`：文本输入，支持初始值、占位符、最小/最大长度和敏感输入。

```ts
const approved = await remote.confirm(ctx, {
  title: "是否执行部署？",
  description: "该操作会更新生产环境",
  toolName: "bash",
  argumentSummary: "kubectl apply -f deploy.yaml",
  confirmLabel: "部署",
  cancelLabel: "取消",
  timeoutMs: 60_000,
});

const environment = await remote.select(ctx, {
  title: "选择环境",
  options: [
    { value: "staging", label: "预发布", description: "用于发布前验证" },
    { value: "production", label: "生产", description: "面向真实用户" },
  ],
});

const token = await remote.input(ctx, {
  title: "输入一次性令牌",
  initialValue: "TOKEN-",
  minLength: 8,
  maxLength: 64,
  secret: true,
});
```

## 完整问卷

`createPiRemoteInteraction(pi, extensionId)` 返回的客户端提供 `questionnaire(options, localUi?)`。它不依赖终端 UI，因此 TUI、RPC 和无窗口会话都可以使用已连接的手机答题。没有远程 broker 时，需要提供实现了 `questionnaire` 的本地 adapter，否则立即报不可用，避免无限等待。

```ts
const answers = await remote.questionnaire({
  title: "确认实施方案",
  timeoutMs: null,
  signal,
  questions: [{
    id: "targets",
    header: "范围",
    question: "需要处理哪些部分？",
    multiSelect: true,
    allowOther: true,
    allowNotes: true,
    options: [
      { value: "api", label: "API", description: "服务接口" },
      { value: "db", label: "数据库", description: "数据存储" },
    }],
  }],
});
// [{ id: "targets", values: ["api", "db"], other?: string, notes?: string }]
```

每份问卷包含 1–16 题、每题 1–32 个选项；问题 ID 和题内选项 value 必须唯一。每题需选至少一个选项或填写 Other；单选的普通选项和 Other 互斥。Other 与 notes 最大 4000 字符。手机在本地保存草稿，编辑和切题不会发送答案，只有整份有效提交才 resolve Promise。`timeoutMs: null` 表示持续等待，直至回答、取消或拥有者关闭。

手机取消发送 `{ kind: "cancel" }`，SDK 以 `RemoteInteractionError`（`code: "cancelled"`）结束等待。调用方必须将明确取消作为终态，不能当成远程不可用而继续等待本地答案。已有自定义本地问卷可以与远程表单竞争，先完成的一方生效并中止另一方。

SDK 会验证 runtime ID、extension ID、request ID、响应类型、选项、文本长度和问卷完整性。部分答案、重复或未知 ID、非法选项及多选约束不符均不会完成请求。本地端与手机端只有第一个有效响应生效；普通重连重发相同 request ID，显式取消、超时或关闭才结束请求。

SDK 不会尝试镜像任意 `ctx.ui.custom()` 或第三方终端组件。需要在手机渲染的扩展交互必须使用 SDK 当前支持的声明式类型。

完整集成方式见仓库根目录的 `README.md`。
