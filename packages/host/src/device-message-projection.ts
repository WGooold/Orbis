/** ADR-0067 G01: optional menu prose stays on Host; exact call targets stay on wire.
 * Run before serialization, not in the per-device format converter, so token frames
 * keep their fast path. Only registered menu paths are projected: decision content
 * and arbitrary chat / tool JSON may also contain description and must survive.
 */
type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
type Projection = (value: unknown) => unknown;

const field = (value: unknown, key: string, project: Projection): unknown => {
  if (!isObject(value) || !Object.hasOwn(value, key)) return value;
  const next = project(value[key]);
  return next === value[key] ? value : { ...value, [key]: next };
};

const omit = (value: unknown, keys: readonly string[]): unknown => {
  if (!isObject(value) || !keys.some(key => Object.hasOwn(value, key))) return value;
  const next = { ...value };
  for (const key of keys) delete next[key];
  return next;
};

const array = (value: unknown, project: Projection): unknown => {
  if (!Array.isArray(value)) return value;
  let next: unknown[] | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const item = project(value[i]);
    if (item !== value[i]) { next ??= value.slice(); next[i] = item; }
  }
  return next ?? value;
};

const record = (value: unknown, project: Projection): unknown => {
  if (!isObject(value)) return value;
  let next: ObjectValue | undefined;
  for (const [key, item] of Object.entries(value)) {
    const projected = project(item);
    if (projected !== item) { next ??= { ...value }; next[key] = projected; }
  }
  return next ?? value;
};

const option: Projection = value => omit(value, ["description"]);
const argument: Projection = value => field(omit(value, ["hint"]), "options", value => array(value, option));
const command: Projection = value => field(omit(value, ["description", "hint"]), "argument", argument);
const management: Projection = value => field(value, "settings", value => array(value,
  value => field(value, "options", value => array(value, option))));
const metadata: Projection = value => field(value, "permissionManagement", management);

const runtimeEvent: Projection = value => {
  if (!isObject(value)) return value;
  if (value.type === "runtime.capabilities") return field(value, "capabilities",
    value => field(value, "commands", value => array(value, command)));
  if (value.type === "runtime.metadata") return field(value, "metadata", metadata);
  return value;
};

const domain: Projection = value => {
  if (!isObject(value)) return value;
  if (value.domain === "capabilities" || value.domain === "resources") return field(value, "value", value => record(value, command));
  if (value.domain === "identity") return field(value, "value", metadata);
  if (value.domain === "permissions") return field(value, "value", value => field(value, "management", management));
  return value;
};

export function projectDeviceMessage(message: object): object {
  const value = message as ObjectValue;
  switch (value.type) {
    case "runtime.event": return field(value, "event", runtimeEvent) as object;
    case "runtime.online": return field(value, "runtime", metadata) as object;
    case "device.ready": return field(value, "runtimes", value => array(value, metadata)) as object;
    case "agent.state.snapshot": return value.scope === "agent"
      ? field(value, "domains", value => array(value, domain)) as object : message;
    default: return message;
  }
}

export const encodeDeviceMessage = (message: object): Buffer => Buffer.from(JSON.stringify(projectDeviceMessage(message)), "utf8");

const compactEvents = new WeakMap<object, unknown>();
const pick = (value: unknown, keys: readonly string[]): unknown => !isObject(value) ? {} :
  Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
const messageKeys = ["messageId", "role", "content", "timestamp", "toolCallId", "toolName", "toolSummary", "isError",
  "clientMessageId", "display", "stopReason", "errorMessage", "command", "output"];
const publicBlocks = (value: unknown): unknown => !Array.isArray(value) ? typeof value === "string" ? value : [] : value.flatMap(block => {
  if (!isObject(block)) return [];
  const keys = block.type === "text" ? ["type", "text", "truncated", "originalBytes"]
    : block.type === "thinking" ? ["type", "text", "thinking", "truncated", "originalBytes"]
      : block.type === "artifact" ? ["type", "artifact"]
        : block.type === "tool_call" || block.type === "toolCall" ? ["type", "id", "name", "toolCallId", "toolName", "summary"] : undefined;
  return keys ? [pick(block, keys)] : [];
});
const commandResultKeys = ["provider", "modelId", "level", "sessionName", "sessionId", "runtimeId", "cwd", "leafId", "isIdle",
  "copied", "compacted", "reloaded", "shutdown", "command", "accepted", "editorText"];

/** FT-G08: only explicitly selected peers receive the registered public entry
 * projection. Versioned source authority can replace previously cached native
 * metadata; unversioned history and explicit entry-detail responses stay exact.
 * Attachment paths remain where mobile matching currently needs their identity.
 */
export function projectCompactDeviceMessage(message: object): object {
  const envelope = projectDeviceMessage(message) as ObjectValue;
  if (envelope.type !== "runtime.event" || !isObject(envelope.event)) return envelope;
  const event = envelope.event;
  if (event.type === "command.result" && isObject(event.result)) return { ...envelope, event: { ...event, result: pick(event.result, commandResultKeys) } };
  if (!["session.snapshot", "session.patch"].includes(String(event.type)) || !isObject(event.source) || event.source.ready !== true) return envelope;
  let projected = compactEvents.get(event);
  if (projected === undefined) {
    projected = field(event, "entries", value => array(value, item => {
      if (!isObject(item) || !isObject(item.data)) return item;
      const data = item.data;
      let publicData: unknown;
      if (item.type === "message") publicData = field(pick(data, ["message", "remoteFailure"]), "message", value =>
        field(pick(value, messageKeys), "content", publicBlocks));
      else if (item.type === "compaction") publicData = pick(data, ["summary", "firstKeptEntryId"]);
      else if (item.type === "branch_summary") publicData = pick(data, ["summary"]);
      else if (item.type === "custom_message") publicData = field(field(pick(data, ["display", "content", "details"]), "content", publicBlocks), "details", value => pick(value, ["remoteArtifact"]));
      else publicData = {};
      return { ...item, data: publicData };
    }));
    compactEvents.set(event, projected);
  }
  return { ...envelope, event: projected };
}
