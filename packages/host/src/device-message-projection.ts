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
