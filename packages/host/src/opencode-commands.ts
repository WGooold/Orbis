import { createHash } from "node:crypto";
import { ClientError } from "@opencode/client";
import type { InteractionResponse, RuntimeCapabilities, RuntimeCommandStatus, SessionConfigurationCatalog, SessionConfigurationValues } from "@orbis/protocol";
import type { OpenCodeClient } from "./opencode-service-connection.js";
import type { NativeForm, NativeSession } from "./opencode-projection.js";

type NativeModel = NonNullable<NativeSession["model"]>;
export const clientMessageKey = "orbis.clientMessageId";
export const modelValue = (model: NativeModel) => JSON.stringify([model.providerID, model.id]);

export class OpenCodeCommandError extends Error {
  constructor(readonly code: string, readonly status: RuntimeCommandStatus = "failure") { super(code); }
}

export function commandFailure(error: unknown): { error: string; status: RuntimeCommandStatus } {
  if (error instanceof OpenCodeCommandError) return { error: error.code, status: error.status };
  if (error instanceof ClientError) {
    const cause = error.cause as { status?: number } | undefined;
    if (error.reason === "UnexpectedStatus" && cause?.status !== undefined && cause.status >= 400 && cause.status < 500)
      return { error: "opencode_request_rejected", status: "failure" };
    return { error: "opencode_result_unconfirmed", status: "unconfirmed" };
  }
  if (error && typeof error === "object" && "_tag" in error && typeof error._tag === "string") {
    // The pinned SDK throws a declared API error as its tagged JSON response.
    return { error: "opencode_request_rejected", status: "failure" };
  }
  return { error: "opencode_result_unconfirmed", status: "unconfirmed" };
}

export async function readModels(client: OpenCodeClient, cwd: string, options: { signal: AbortSignal }) {
  const location = { directory: cwd };
  const [{ data }, defaultModel] = await Promise.all([client.model.list({ location, types: ["chat"] }, options), client.model.default({ location }, options)]);
  const choices = new Map<string, { ref: NativeModel; row: SessionConfigurationCatalog["models"][number] }>();
  for (const model of data) {
    if (!model.enabled || !model.providerID || model.providerID.length > 128 || !model.id || model.id.length > 256) continue;
    const ref = { id: model.id, providerID: model.providerID };
    const value = modelValue(ref);
    if (value.length > 1024 || choices.has(value) || choices.size >= 1000) continue;
    const variants = [...new Set(model.variants.map(variant => variant.id).filter(id => id.length > 0 && id.length <= 64))].slice(0, 32);
    choices.set(value, { ref, row: { value, label: `${model.name || model.id} (${model.providerID})`.slice(0, 512),
      thinking: variants.map(id => ({ value: id, label: id })) } });
  }
  const models = [...choices.values()].map(choice => choice.row);
  const defaultValue = defaultModel.data ? modelValue(defaultModel.data) : undefined;
  const catalog: SessionConfigurationCatalog = { binding: createHash("sha256").update(JSON.stringify(["opencode", cwd,
    models.map(row => [row.value, row.thinking.map(item => item.value).sort()]).sort(), defaultValue])).digest("hex"),
    defaults: defaultValue !== undefined && choices.has(defaultValue) ? { model: defaultValue } : {}, models, permissions: [] };
  return { choices, catalog };
}

export async function readAgents(client: OpenCodeClient, cwd: string, options: { signal: AbortSignal }) {
  const { data } = await client.agent.list({ location: { directory: cwd } }, options);
  return [...new Map(data.filter(agent => !agent.hidden && agent.mode !== "subagent" && agent.id && agent.id.length <= 256)
    .slice(0, 256).map(agent => [agent.id, { value: agent.id, label: (agent.name || agent.id).slice(0, 512) }])).values()];
}

export function selectionModel(models: Awaited<ReturnType<typeof readModels>>, values: SessionConfigurationValues): NativeModel | undefined {
  if (Object.keys(values.permissions ?? {}).length > 0) throw new OpenCodeCommandError("unsupported_configuration");
  if (values.model === undefined && values.thinking === undefined) return undefined;
  const model = values.model === undefined ? undefined : models.choices.get(values.model);
  if (!model || (values.thinking !== undefined && !model.row.thinking.some(variant => variant.value === values.thinking)))
    throw new OpenCodeCommandError("configuration_stale");
  return { ...model.ref, ...(values.thinking === undefined ? {} : { variant: values.thinking }) };
}

export function selectionCommands(info: NativeSession, models: Awaited<ReturnType<typeof readModels>> | undefined,
  agents: Awaited<ReturnType<typeof readAgents>> | undefined): RuntimeCapabilities {
  const commands: RuntimeCapabilities["commands"] = [];
  const current = info.model ? models?.choices.get(modelValue(info.model)) : undefined;
  if (models?.catalog.models.length) commands.push({ name: "model", source: "builtin", description: "Select an OpenCode model",
    argument: { kind: "select", required: true, options: models.catalog.models.map(({ value, label }) => ({ value, label })) } });
  if (current?.row.thinking.length) commands.push({ name: "thinking", source: "builtin", description: "Select a variant of the current OpenCode model",
    argument: { kind: "select", required: true, options: current.row.thinking } });
  if (agents?.length) commands.push({ name: "agent", source: "builtin", description: "Select an OpenCode agent",
    argument: { kind: "select", required: true, options: agents } });
  return { commands };
}

export function formAnswers(form: NativeForm, response: Extract<InteractionResponse, { kind: "questionnaire" }>): Record<string, string | number | boolean | string[]> {
  const invalid = () => new OpenCodeCommandError("invalid_interaction_response");
  const answers = new Map(response.answers.map(answer => [answer.id, answer]));
  if (answers.size !== response.answers.length || response.answers.some(answer => !form.fields.some(field => field.key === answer.id))) throw invalid();
  const mapped: Array<[string, string | number | boolean | string[]]> = [];
  for (const field of form.fields) {
    if (field.type === "external" || field.hidden || field.when?.length) throw invalid();
    const answer = answers.get(field.key);
    const other = answer?.other === "" ? undefined : answer?.other;
    if (answer?.notes) throw invalid();
    const values = answer?.values ?? [];
    if (values.length === 0 && other === undefined) {
      if (field.required) throw invalid();
      continue;
    }
    if (field.type === "multiselect") {
      const all = [...values, ...(other === undefined ? [] : [other])];
      if ((other !== undefined && !field.custom) || new Set(all).size !== all.length ||
        values.some(value => !field.options.some(option => option.value === value)) ||
        (field.minItems !== undefined && all.length < field.minItems) || (field.maxItems !== undefined && all.length > field.maxItems)) throw invalid();
      mapped.push([field.key, all]);
      continue;
    }
    if (values.length > 1 || (values.length && other !== undefined)) throw invalid();
    const value = (values[0] ?? other)!;
    if (field.type === "boolean") {
      if (other !== undefined || (value !== "true" && value !== "false")) throw invalid();
      mapped.push([field.key, value === "true"]);
    } else if (field.type === "integer" || field.type === "number") {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw invalid();
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === "integer" && !Number.isSafeInteger(number)) ||
        (typeof field.minimum === "number" && number < field.minimum) || (typeof field.maximum === "number" && number > field.maximum)) throw invalid();
      mapped.push([field.key, number]);
    } else if (field.type === "string") {
      if ((field.options?.length && !field.custom && !field.options.some(option => option.value === value)) ||
        (field.minLength !== undefined && value.length < field.minLength) || (field.maxLength !== undefined && value.length > field.maxLength)) throw invalid();
      // OpenCode remains the validator for its own string pattern/format and for native constraints.
      mapped.push([field.key, value]);
    }
  }
  return Object.fromEntries(mapped);
}
