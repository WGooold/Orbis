import {
  InteractionRequestSchema,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionnaireQuestion,
} from "@pi-remote/protocol";

type RecordValue = Record<string, unknown>;
type Base = Pick<InteractionRequest, "runtimeId" | "requestId" | "extensionId" | "expiresAt">;
export type CodexInteraction = {
  request: InteractionRequest;
  decline: unknown;
  decode: (response: InteractionResponse) => unknown;
};

export function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
const text = (value: unknown): string => typeof value === "string" ? value : "";
const json = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";
const fail = (message: string): never => { throw new Error(message); };

function permissionDescription(value: unknown): string {
  const permissions = object(value);
  const lines: string[] = [];
  const network = object(permissions.network);
  if (typeof network.enabled === "boolean") lines.push(`网络访问：${network.enabled ? "允许" : "不允许"}`);
  const fs = object(permissions.fileSystem);
  for (const [key, label] of [["read", "读取"], ["write", "写入"]] as const) {
    const paths = fs[key];
    if (Array.isArray(paths)) for (const path of paths) lines.push(`${label}：${String(path)}`);
  }
  if (Array.isArray(fs.entries)) for (const raw of fs.entries) {
    const entry = object(raw);
    const path = object(entry.path);
    const access = entry.access === "write" ? "写入" : entry.access === "read" ? "读取" : "禁止访问";
    lines.push(`${access}：${text(path.path) || text(path.pattern) || json(path.value)}`);
  }
  if (fs.globScanMaxDepth !== undefined) lines.push(`目录扫描最大深度：${String(fs.globScanMaxDepth)}`);
  // Keep unfamiliar fields visible rather than silently hiding part of the requested scope.
  if (Object.keys(permissions).some((key) => !["network", "fileSystem"].includes(key))
    || Object.keys(network).some((key) => key !== "enabled")
    || Object.keys(fs).some((key) => !["read", "write", "entries", "globScanMaxDepth"].includes(key))) lines.push(json(value));
  return lines.join("\n") || "未申请额外权限";
}

/** Each RPC has its own response type. Unknown methods must use a JSON-RPC error. */
export function codexDecline(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": return { decision: "decline" };
    case "item/permissions/requestApproval": return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": return { answers: {} };
    case "mcpServer/elicitation/request": return { action: "decline", content: null };
    default: return undefined;
  }
}

function select(
  base: Base, title: string, description: string,
  choices: Array<{ label: string; description?: string; result: unknown }>,
  decline: unknown, extra: Partial<InteractionRequest> = {},
): CodexInteraction {
  const request = InteractionRequestSchema.parse({ ...base, ...extra, kind: "select", title, description,
    options: choices.map(({ label, description: detail }, i) => ({
      value: String(i), label, ...(detail === undefined ? {} : { description: detail }),
    })),
  });
  return { request, decline, decode: (response) => {
    if (response.kind === "cancel") return decline;
    if (response.kind !== "select") return fail("请选择本次请求提供的批准选项");
    const index = choices.findIndex((_, i) => String(i) === response.value);
    return index < 0 ? fail("批准选项已失效") : choices[index]!.result;
  } };
}

export function prepareCodexInteraction(
  method: string, params: RecordValue, base: Base, item?: RecordValue,
): CodexInteraction {
  const decline = codexDecline(method);
  const context = [text(params.reason), params.cwd ? `工作目录：${text(params.cwd)}` : "",
    params.environmentId ? `执行环境：${text(params.environmentId)}` : ""].filter(Boolean);
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const command = typeof params.command === "string" ? params.command
      : Array.isArray(params.command) ? params.command.map(String).join(" ") : text(item?.command);
    const network = object(params.networkApprovalContext);
    const isCommand = method === "item/commandExecution/requestApproval";
    const details = isCommand ? command : json(item?.changes ?? []);
    if (isCommand && !command && !network.host) context.push("服务端未提供命令预览。");
    if (!isCommand && !item?.changes) context.push("服务端未提供文件差异，请核对电脑端显示后决定。");
    if (details.length > 4_000) context.push(`完整${isCommand ? "命令" : "文件差异"}：\n${details}`);
    if (params.additionalPermissions) context.push(`本次额外权限：\n${permissionDescription(params.additionalPermissions)}`);
    if (params.grantRoot) context.push(`请求写入范围：${text(params.grantRoot)}`);
    if (network.host) context.push(`网络目标：${text(network.protocol)}://${text(network.host)}${network.port ? `:${network.port}` : ""}`);
    if (params.kind === "stdin") context.push("此请求涉及向运行中的命令发送输入。");
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions
      : ["accept", "acceptForSession", "decline", "cancel",
        ...(params.proposedExecpolicyAmendment ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } }] : []),
        ...(Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments.map((amendment) => ({
          applyNetworkPolicyAmendment: { network_policy_amendment: amendment },
        })) : []),
      ];
    const choices = decisions.map((decision) => {
      const labels: Record<string, string> = { accept: "允许一次", acceptForSession: "本会话允许", decline: "拒绝并继续", cancel: "拒绝并结束本轮" };
      if (typeof decision === "string" && labels[decision]) return {
        label: labels[decision]!, result: { decision },
        ...(decision === "acceptForSession" ? { description: "授权在当前会话内有效，后续匹配的请求可直接执行。" } : {}),
      };
      const value = object(decision);
      if (value.acceptWithExecpolicyAmendment) return { label: "允许并记住命令规则", description: `以后匹配此规则的命令可直接执行：\n${json(object(value.acceptWithExecpolicyAmendment).execpolicy_amendment)}`, result: { decision } };
      if (value.applyNetworkPolicyAmendment) {
        const rule = object(object(value.applyNetworkPolicyAmendment).network_policy_amendment);
        return { label: `${rule.action === "deny" ? "拒绝" : "允许"}并记住网络规则`, description: `目标：${text(rule.host)}\n此规则将用于后续网络请求。`, result: { decision } };
      }
      return fail("服务端提供了暂不支持的批准选项，请在电脑端处理");
    });
    return select(base, network.host ? "批准网络访问" : isCommand ? "批准执行命令" : "批准修改文件",
      context.join("\n\n"), choices, decline, {
        toolName: isCommand ? "commandExecution" : "fileChange",
        ...(details ? { argumentSummary: details.length > 4_000 ? "完整内容见下方。" : details } : {}),
      });
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = object(params.permissions);
    if (Object.keys(permissions).some((key) => key !== "network" && key !== "fileSystem")) fail("无法识别请求的权限范围");
    context.push(`申请的权限范围：\n${permissionDescription(permissions)}`);
    return select(base, "批准额外权限", context.join("\n\n"), [
      { label: "允许本轮使用", description: "仅授予上方列出的权限，本轮结束后失效。", result: { permissions, scope: "turn" } },
      { label: "允许本会话使用", description: "仅授予上方列出的权限，后续轮次仍可使用。", result: { permissions, scope: "session" } },
      { label: "拒绝授权", result: decline },
    ], decline);
  }
  if (method === "item/tool/requestUserInput") {
    const originals = Array.isArray(params.questions) ? params.questions.map(object) : [];
    if (new Set(originals.map((q) => q.id)).size !== originals.length) fail("提问包含重复的问题标识，无法提交回答");
    const questions: QuestionnaireQuestion[] = originals.map((q) => {
      const options = Array.isArray(q.options) ? q.options.map(object) : [];
      return {
        id: text(q.id), header: text(q.header).slice(0, 100), question: text(q.question),
        options: options.map((option, i) => ({ value: String(i), label: text(option.label), description: text(option.description) })),
        allowOther: options.length === 0 || q.isOther === true,
        secret: q.isSecret === true,
      };
    });
    const request = InteractionRequestSchema.parse({ ...base, kind: "questionnaire", title: "Codex 需要你的回答", questions });
    return { request, decline, decode: (response) => {
      if (response.kind === "cancel") return decline;
      const answers = questionnaireAnswers(questions, response);
      return { answers: Object.fromEntries(originals.map((q, i) => {
        const answer = answers[i]!;
        const options = Array.isArray(q.options) ? q.options.map(object) : [];
        return [text(q.id), { answers: [...answer.values.map((value) => text(options[Number(value)]?.label)),
          ...(answer.other?.trim() ? [answer.other.trim()] : [])] }];
      })) };
    } };
  }
  if (method === "mcpServer/elicitation/request") return prepareElicitation(params, base);
  return fail(`暂不支持的 Codex 请求：${method}`);
}

function questionnaireAnswers(questions: QuestionnaireQuestion[], response: InteractionResponse) {
  if (response.kind !== "questionnaire" || response.answers.length !== questions.length
    || new Set(response.answers.map((a) => a.id)).size !== questions.length) return fail("请完整回答本次请求中的问题");
  return questions.map((q) => {
    const a = response.answers.find((candidate) => candidate.id === q.id);
    if (!a || new Set(a.values).size !== a.values.length || a.values.some((v) => !q.options.some((o) => o.value === v))
      || (a.other !== undefined && (!q.allowOther || !a.other.trim())) || a.notes) return fail("回答包含无效选项");
    const count = a.values.length + (a.other?.trim() ? 1 : 0);
    if (count === 0 || (!q.multiSelect && count !== 1)) return fail("请选择一个答案或填写内容");
    return a;
  });
}

function prepareElicitation(params: RecordValue, base: Base): CodexInteraction {
  const decline = { action: "decline", content: null };
  const cancel = { action: "cancel", content: null };
  const description = `MCP 服务：${text(params.serverName)}\n\n${text(params.message)}`;
  if (params.mode === "url") {
    const request = InteractionRequestSchema.parse({ ...base, kind: "confirm", title: "完成网页操作",
      description, externalUrl: text(params.url), confirmLabel: "我已完成网页操作", cancelLabel: "拒绝",
    });
    return { request, decline, decode: (response) => {
      if (response.kind === "cancel") return cancel;
      if (response.kind !== "confirm") return fail("请确认网页操作是否已完成");
      return response.value ? { action: "accept", content: null } : decline;
    } };
  }
  if (params.mode !== "form" && params.mode !== undefined) return fail("此 MCP 表单需要在电脑端处理");
  const schema = object(params.requestedSchema);
  if (schema.type !== "object") return fail("无法识别 MCP 表单格式");
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = Object.entries(object(schema.properties));
  if (properties.length === 0) {
    const request = InteractionRequestSchema.parse({ ...base, kind: "confirm", title: "MCP 请求确认", description });
    return { request, decline, decode: (response) => response.kind === "confirm"
      ? response.value ? { action: "accept", content: {} } : decline
      : response.kind === "cancel" ? cancel : fail("请确认或拒绝请求") };
  }
  const fields = properties.map(([id, raw]) => {
    const field = object(raw);
    const array = field.type === "array";
    const source = array ? object(field.items) : field;
    const enumValues = Array.isArray(source.enum) ? source.enum : undefined;
    const titled = Array.isArray(source.oneOf) ? source.oneOf : Array.isArray(source.anyOf) ? source.anyOf : undefined;
    let values: unknown[] | undefined = enumValues ?? titled?.map((entry) => object(entry).const);
    if (field.type === "boolean") values = [true, false];
    if (!values && field.type !== "string" && field.type !== "number" && field.type !== "integer") fail(`暂不支持表单字段 ${id}`);
    if (values?.some((v) => typeof v !== "string" && typeof v !== "boolean")) fail(`无效表单选项 ${id}`);
    const options = (values ?? []).map((value, index) => ({ value: String(index),
      label: typeof value === "boolean" ? value ? "是" : "否"
        : text(object(titled?.[index]).title) || text((Array.isArray(field.enumNames) ? field.enumNames : [])[index]) || String(value),
    }));
    if (!required.includes(id)) options.push({ value: "omit", label: "不填写此项" });
    if (array && (typeof field.minItems !== "number" || field.minItems === 0)) options.push({ value: "empty", label: "不选择任何项" });
    const constraints = [
      typeof field.minimum === "number" ? `最小值：${field.minimum}` : "",
      typeof field.maximum === "number" ? `最大值：${field.maximum}` : "",
      typeof field.minLength === "number" ? `最少 ${field.minLength} 个字符` : "",
      typeof field.maxLength === "number" ? `最多 ${field.maxLength} 个字符` : "",
      typeof field.minItems === "number" ? `至少选 ${field.minItems} 项` : "",
      typeof field.maxItems === "number" ? `最多选 ${field.maxItems} 项` : "",
      field.type === "integer" ? "请输入整数" : field.type === "number" ? "请输入数字" : "",
      field.format ? `格式：${text(field.format)}` : "",
    ];
    const question: QuestionnaireQuestion = { id, question: [text(field.title) || id, text(field.description), ...constraints].filter(Boolean).join("\n"),
      options, allowOther: !values, multiSelect: array,
    };
    return { id, field, values, question };
  });
  const questions = fields.map((field) => field.question);
  const request = InteractionRequestSchema.parse({ ...base, kind: "questionnaire", title: "填写 MCP 表单", description, questions });
  return { request, decline, decode: (response) => {
    if (response.kind === "cancel") return cancel;
    const answers = questionnaireAnswers(questions, response);
    const content = Object.create(null) as RecordValue;
    fields.forEach(({ id, field, values }, i) => {
      const answer = answers[i]!;
      if (answer.values.includes("omit")) {
        if (answer.values.length !== 1 || answer.other) fail("不填写不能与其他答案同时选择");
        return;
      }
      if (answer.values.includes("empty")) {
        if (answer.values.length !== 1 || answer.other) fail("不选择任何项不能与其他答案同时选择");
        content[id] = [];
        return;
      }
      let value: unknown = answer.other?.trim();
      if (values) value = field.type === "array" ? answer.values.map((v) => values[Number(v)]) : values[Number(answer.values[0])];
      else if (field.type === "number" || field.type === "integer") {
        value = Number(value);
        if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) fail(`${id} 必须是有效数字`);
        if ((typeof field.minimum === "number" && (value as number) < field.minimum)
          || (typeof field.maximum === "number" && (value as number) > field.maximum)) fail(`${id} 超出允许的数值范围`);
      }
      if (typeof value === "string") {
        if ((typeof field.minLength === "number" && value.length < field.minLength)
          || (typeof field.maxLength === "number" && value.length > field.maxLength)) fail(`${id} 长度不符合要求`);
        if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(`${id} 需要有效邮箱`);
        if (field.format === "uri") { try { new URL(value); } catch { fail(`${id} 需要有效网址`); } }
        if ((field.format === "date" || field.format === "date-time") && !Number.isFinite(Date.parse(value))) fail(`${id} 需要有效日期`);
      }
      if (Array.isArray(value) && ((typeof field.minItems === "number" && value.length < field.minItems)
        || (typeof field.maxItems === "number" && value.length > field.maxItems))) fail(`${id} 选择数量不符合要求`);
      content[id] = value;
    });
    return { action: "accept", content };
  } };
}
