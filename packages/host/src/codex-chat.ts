// Responses <-> Chat conversion adapted from CC Switch f8788719 (MIT).
import { createHash, randomUUID } from "node:crypto";
import { object, text, type Obj } from "./provider-proxy-config.js";
import { ProviderError } from "./provider-error.js";
import { applyReasoning } from "./codex-reasoning.js";

const rows = (value: unknown): Obj[] => Array.isArray(value) ? value.map(object) : [];
const stringify = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? "");
type ToolSpec = { name: string; namespace?: string; type: "function" | "custom" | "tool_search" };
function toolName(name: string, namespace?: string): string {
  const full = namespace ? `${namespace}__${name}` : name;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(full) ? full : `${full.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}_${createHash("sha256").update(full).digest("hex").slice(0, 12)}`;
}
export class CodexTools {
  readonly specs = new Map<string, ToolSpec>();
  readonly tools: Obj[] = [];
  constructor(body: Obj) {
    const definitions = [...(Array.isArray(body.tools) ? body.tools : [])];
    for (const row of rows(body.input)) if (["tool_search_output", "additional_tools"].includes(text(row.type))) definitions.push(...(Array.isArray(row.tools) ? row.tools : []));
    for (const tool of definitions) this.add(tool);
  }
  add(value: unknown, namespace?: string): void {
    const row = typeof value === "string" ? { type: "custom", name: value } : object(value);
    if (row.type === "namespace") { for (const child of rows(row.tools ?? row.children)) this.add(child, text(row.name)); return; }
    // Hosted tools have no client-side Chat equivalent; CC Switch omits their declarations.
    if (!["function", "custom", "tool_search"].includes(text(row.type))) return;
    const fn = row.type === "function" && row.function ? object(row.function) : row;
    const name = text(fn.name) || (row.type === "tool_search" ? "tool_search" : "");
    if (!name) return;
    const chatName = toolName(name, namespace);
    const spec: ToolSpec = { name, type: row.type as ToolSpec["type"], ...(namespace ? { namespace } : {}) };
    const existing = this.specs.get(chatName);
    if (existing) { if (JSON.stringify(existing) !== JSON.stringify(spec)) throw new ProviderError("Conflicting flattened tool names"); return; }
    this.specs.set(chatName, spec);
    const parameters = row.type === "custom" ? { type: "object", properties: { input: { type: "string", description: "Raw input for the original custom tool. Preserve formatting exactly." } }, required: ["input"] }
      : row.type === "tool_search" ? { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] } : fn.parameters ?? { type: "object", properties: {} };
    this.tools.push({ type: "function", function: { name: chatName, description: row.type === "custom" ? `${text(row.description)}\nOriginal tool definition:\n${JSON.stringify(row)}` : text(fn.description), parameters, ...(fn.strict !== undefined ? { strict: fn.strict } : {}) } });
  }
  call(item: Obj): Obj {
    const custom = item.type === "custom_tool_call";
    return { id: text(item.call_id), type: "function", function: { name: toolName(text(item.name) || "tool_search", text(item.namespace) || undefined), arguments: custom ? JSON.stringify({ input: item.input }) : stringify(item.arguments ?? {}) } };
  }
  output(name: string, callId: string, args: string): Obj {
    const spec = this.specs.get(name);
    if (!spec) throw new ProviderError("Upstream returned an unknown tool");
    if (!callId) throw new ProviderError("Upstream tool call is missing its ID");
    if (spec.type === "custom") {
      let input: unknown; try { input = object(JSON.parse(args)).input; } catch { throw new ProviderError("Upstream custom tool input is invalid JSON"); }
      if (typeof input !== "string") throw new ProviderError("Upstream custom tool input must be a string");
      return { type: "custom_tool_call", id: `ctc_${randomUUID()}`, call_id: callId, name: spec.name, ...(spec.namespace ? { namespace: spec.namespace } : {}), input, status: "completed" };
    }
    if (spec.type === "tool_search") return { type: "tool_search_call", id: `tsc_${randomUUID()}`, call_id: callId, arguments: JSON.parse(args) as unknown, execution: "client", status: "completed" };
    try { JSON.parse(args); } catch { throw new ProviderError("Upstream function arguments are invalid JSON"); }
    return { type: "function_call", id: `fc_${randomUUID()}`, call_id: callId, name: spec.name, arguments: args, ...(spec.namespace ? { namespace: spec.namespace } : {}), status: "completed" };
  }
}

function content(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return stringify(value);
  const parts = value.map(part => {
    const row = object(part);
    if (["input_text", "output_text", "text"].includes(text(row.type))) return { type: "text", text: text(row.text) };
    if (row.type === "input_image") return { type: "image_url", image_url: { url: row.image_url, ...(row.detail ? { detail: row.detail } : {}) } };
    if (row.type === "image_url") return row;
    if (row.type === "image" && typeof row.data === "string") return { type: "image_url", image_url: { url: `data:${text(row.mimeType) || "image/png"};base64,${row.data}` } };
    if (row.type === "input_audio" || row.type === "file") return row;
    if (row.type === "input_file") return { type: "file", file: { ...(row.filename ? { filename: row.filename } : {}), ...(row.file_data ? { file_data: row.file_data } : {}), ...(row.file_id ? { file_id: row.file_id } : {}) } };
    if (row.type === "refusal") return { type: "text", text: text(row.refusal) };
    throw new ProviderError(`Unsupported Responses content: ${text(row.type)}`);
  });
  return parts.every(part => part.type === "text") ? parts.map(part => text(part.text)).join("\n") : parts;
}
function reasoningText(item: Obj): string {
  return text(item.reasoning_content) || text(item.reasoning) || text(object(item.reasoning).text) || text(object(item.reasoning).content) || rows(item.reasoning_details ?? item.summary).map(part => text(part.text) || text(part.summary)).join("\n");
}
function toolOutput(value: unknown): { output: string; media: Obj[] } {
  const media: Obj[] = [];
  const extract = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(extract);
    const row = object(value);
    if (["input_image", "image_url", "input_file", "file", "input_audio", "image"].includes(text(row.type))) {
      const converted = content([row]);
      if (Array.isArray(converted)) media.push(...converted.map(object));
      return "[Media attached after tool results]";
    }
    if (row.content !== undefined) return { ...row, content: extract(row.content) };
    return value;
  };
  let parsed = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { /* Keep plain tool output byte-for-byte. */ } }
  const extracted = extract(parsed);
  return { output: stringify(media.length ? extracted : value), media };
}
export function responsesToChat(body: Obj, model: string, options: Obj = {}, history: ReadonlyMap<string, string> = new Map()): { body: Obj; tools: CodexTools } {
  if (body.previous_response_id) throw new ProviderError("Chat conversion requires stateless Responses input; previous_response_id is not supported");
  const tools = new CodexTools(body);
  const messages: Obj[] = [];
  const pendingMedia: Obj[] = [];
  const flushMedia = () => { if (pendingMedia.length) messages.push({ role: "user", content: pendingMedia.splice(0) }); };
  if (text(body.instructions)) messages.push({ role: "system", content: body.instructions });
  let reasoning = "";
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : rows(body.input);
  for (const item of input) {
    if (item.type === "reasoning") { reasoning += reasoningText(item); continue; }
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(text(item.type))) {
      flushMedia();
      const previous = messages.at(-1);
      const message: Obj = previous?.role === "assistant" ? previous : { role: "assistant", content: null, tool_calls: [] };
      message.tool_calls = [...(Array.isArray(message.tool_calls) ? message.tool_calls : []), tools.call(item)];
      const thoughts = reasoningText(item) || reasoning || history.get(text(item.call_id));
      if (thoughts) message.reasoning_content = thoughts;
      if (options.requiresReasoningContent === true && !message.reasoning_content) message.reasoning_content = ".";
      if (previous !== message) messages.push(message);
      reasoning = ""; continue;
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(text(item.type))) {
      const { output, media } = toolOutput(item.type === "tool_search_output" ? item.output ?? item.tools ?? "" : item.output ?? "");
      messages.push({ role: "tool", tool_call_id: text(item.call_id), content: output });
      if (media.length) pendingMedia.push({ type: "text", text: `Media from tool ${text(item.call_id)}` }, ...media);
      continue;
    }
    if (item.type === "additional_tools") continue;
    flushMedia();
    if (item.type && item.type !== "message") throw new ProviderError(`Unsupported Responses history item: ${text(item.type)}`);
    const role = text(item.role);
    if (!["system", "developer", "user", "assistant"].includes(role)) throw new ProviderError("Invalid Responses message role");
    messages.push({ role: role === "developer" && options.supportsDeveloperRole === false ? "system" : role, content: content(item.content), ...(role === "assistant" && (reasoning || reasoningText(item)) ? { reasoning_content: reasoningText(item) || reasoning } : {}) });
    reasoning = "";
  }
  flushMedia();
  const chat: Obj = { model: model || body.model, messages, stream: body.stream === true };
  if (tools.tools.length) chat.tools = tools.tools;
  for (const key of ["temperature", "top_p", "parallel_tool_calls", "frequency_penalty", "presence_penalty", "stop", "seed", "user", "service_tier"]) if (body[key] !== undefined) chat[key] = body[key];
  if (body.max_output_tokens !== undefined) chat[options.maxTokensField === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens"] = body.max_output_tokens;
  applyReasoning(chat, body, options);
  if (chat.stream && options.supportsStreamOptions !== false) chat.stream_options = { include_usage: true };
  if (body.tool_choice !== undefined) {
    const choice = object(body.tool_choice);
    chat.tool_choice = typeof body.tool_choice === "string" ? body.tool_choice : { type: "function", function: { name: toolName(text(choice.name), text(choice.namespace) || undefined) } };
  }
  const format = object(object(body.text).format);
  if (format.type === "json_schema") chat.response_format = { type: "json_schema", json_schema: { name: format.name, schema: format.schema, strict: format.strict } };
  else if (format.type === "json_object") chat.response_format = { type: "json_object" };
  if (options.supportsStrictMode === false) for (const tool of tools.tools) delete object(tool.function).strict;
  if (!tools.tools.length) { delete chat.tool_choice; delete chat.parallel_tool_calls; }
  const systems = messages.filter(message => message.role === "system");
  if (systems.length > 1) chat.messages = [{ role: "system", content: systems.map(message => stringify(message.content)).join("\n\n") }, ...messages.filter(message => message.role !== "system")];
  return { body: chat, tools };
}

export type ResponseEvent = Obj & { type: string };
/** One converter per request. Output IDs and indexes stay stable across all SSE events. */
export class ChatResponses {
  readonly id = `resp_${randomUUID()}`;
  readonly created = Math.floor(Date.now() / 1000);
  readonly output: Obj[] = [];
  readonly #calls = new Map<number, { id: string; name: string; args: string }>();
  #text: Obj | undefined; #reasoning: Obj | undefined;
  #started = false; #finish = ""; #usage: Obj = {}; #sequence = 0; #thinkBuffer = ""; #thinkMode: "detect" | "reasoning" | "text" = "detect";
  constructor(readonly tools: CodexTools, readonly model: string, readonly onReasoning?: (id: string, reasoning: string) => void) {}
  #event(type: string, values: Obj): ResponseEvent { return { type, sequence_number: this.#sequence++, ...structuredClone(values) }; }
  #response(status: string): Obj { return { id: this.id, object: "response", created_at: this.created, status, model: this.model, output: structuredClone(this.output), usage: this.#usage, error: null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null }; }
  push(chunk: Obj): ResponseEvent[] {
    if (chunk.error) throw new ProviderError("Upstream returned an error event");
    const events: ResponseEvent[] = [];
    if (!this.#started) {
      this.#started = true;
      events.push(this.#event("response.created", { response: this.#response("in_progress") }), this.#event("response.in_progress", { response: this.#response("in_progress") }));
    }
    const usage = object(chunk.usage);
    if (Object.keys(usage).length) this.#usage = { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0, input_tokens_details: { cached_tokens: object(usage.prompt_tokens_details).cached_tokens ?? 0 }, output_tokens_details: { reasoning_tokens: object(usage.completion_tokens_details).reasoning_tokens ?? 0 } };
    const choice = rows(chunk.choices)[0]; if (!choice) return events;
    const delta = object(choice.delta ?? choice.message);
    const thoughts = reasoningText(delta);
    if (thoughts) events.push(...this.#append(thoughts, true));
    const piece = text(delta.content) || text(delta.refusal);
    if (piece) events.push(...this.#content(piece));
    for (const [i, tool] of rows(delta.tool_calls).entries()) {
      const index = typeof tool.index === "number" ? tool.index : i;
      if (!Number.isSafeInteger(index) || index < 0 || index > 1000) throw new ProviderError("Invalid upstream tool index");
      let call = this.#calls.get(index);
      if (!call) { call = { id: "", name: "", args: "" }; this.#calls.set(index, call); }
      const fn = object(tool.function);
      if (tool.id) call.id = text(tool.id);
      call.name += text(fn.name); call.args += text(fn.arguments);
    }
    if (choice.finish_reason) this.#finish = text(choice.finish_reason);
    return events;
  }
  #content(piece: string): ResponseEvent[] {
    if (this.#thinkMode === "text") return this.#append(piece, false);
    this.#thinkBuffer += piece;
    if (this.#thinkMode === "detect") {
      const trimmed = this.#thinkBuffer.trimStart();
      if ("<think>".startsWith(trimmed)) return [];
      if (trimmed.startsWith("<think>")) { this.#thinkBuffer = trimmed.slice(7); this.#thinkMode = "reasoning"; }
      else { const value = this.#thinkBuffer; this.#thinkBuffer = ""; this.#thinkMode = "text"; return this.#append(value, false); }
    }
    const end = this.#thinkBuffer.indexOf("</think>");
    if (end < 0) {
      const safe = this.#thinkBuffer.slice(0, -8); this.#thinkBuffer = this.#thinkBuffer.slice(-8);
      return safe ? this.#append(safe, true) : [];
    }
    const thoughts = this.#thinkBuffer.slice(0, end); const answer = this.#thinkBuffer.slice(end + 8);
    this.#thinkBuffer = ""; this.#thinkMode = "text";
    return [...(thoughts ? this.#append(thoughts, true) : []), ...(answer ? this.#append(answer, false) : [])];
  }
  #append(value: string, reasoning: boolean): ResponseEvent[] {
    const events: ResponseEvent[] = [];
    let item = reasoning ? this.#reasoning : this.#text;
    if (!item) {
      item = reasoning ? { type: "reasoning", id: `rs_${randomUUID()}`, summary: [] } : { type: "message", role: "assistant", id: `msg_${randomUUID()}`, status: "in_progress", content: [] };
      this.output.push(item);
      if (reasoning) this.#reasoning = item; else this.#text = item;
      events.push(this.#event("response.output_item.added", { output_index: this.output.indexOf(item), item }));
      if (reasoning) item.summary = [{ type: "summary_text", text: "" }]; else item.content = [{ type: "output_text", text: "", annotations: [] }];
      events.push(this.#event(reasoning ? "response.reasoning_summary_part.added" : "response.content_part.added", { item_id: item.id, output_index: this.output.indexOf(item), [reasoning ? "summary_index" : "content_index"]: 0, part: rows(reasoning ? item.summary : item.content)[0] }));
    }
    const part = rows(reasoning ? item.summary : item.content)[0]!;
    part.text = text(part.text) + value;
    events.push(this.#event(reasoning ? "response.reasoning_summary_text.delta" : "response.output_text.delta", { item_id: item.id, output_index: this.output.indexOf(item), [reasoning ? "summary_index" : "content_index"]: 0, delta: value }));
    return events;
  }
  finish(): ResponseEvent[] {
    if (!this.#finish) throw new ProviderError("Upstream stream ended before a finish reason");
    if (!["stop", "tool_calls", "function_call", "length"].includes(this.#finish)) throw new ProviderError("Upstream refused or failed the response");
    const events: ResponseEvent[] = [];
    if (this.#thinkBuffer) events.push(...this.#append(this.#thinkBuffer, this.#thinkMode === "reasoning"));
    this.#thinkBuffer = "";
    for (const item of this.output) {
      const reasoning = item.type === "reasoning"; const part = rows(reasoning ? item.summary : item.content)[0]!;
      const common = { item_id: item.id, output_index: this.output.indexOf(item), [reasoning ? "summary_index" : "content_index"]: 0 };
      events.push(this.#event(reasoning ? "response.reasoning_summary_text.done" : "response.output_text.done", { ...common, text: part.text }));
      events.push(this.#event(reasoning ? "response.reasoning_summary_part.done" : "response.content_part.done", { ...common, part }));
      item.status = "completed";
      events.push(this.#event("response.output_item.done", { output_index: this.output.indexOf(item), item }));
    }
    const reasoning = rows(this.#reasoning?.summary).map(row => text(row.text)).join("\n");
    for (const [, call] of [...this.#calls].sort(([a], [b]) => a - b)) {
      // Buffer fragmented names and custom tool JSON until they are valid. A tool
      // must never be executed from partially received or malformed arguments.
      const item = this.tools.output(call.name, call.id, call.args);
      this.onReasoning?.(call.id, reasoning);
      const index = this.output.length; this.output.push(item);
      const field = item.type === "custom_tool_call" ? "input" : "arguments";
      events.push(this.#event("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", [field]: "" } }));
      if (item.type !== "tool_search_call") {
        events.push(this.#event(`response.${item.type === "custom_tool_call" ? "custom_tool_call_input" : "function_call_arguments"}.delta`, { item_id: item.id, output_index: index, delta: item[field] }));
        events.push(this.#event(`response.${item.type === "custom_tool_call" ? "custom_tool_call_input" : "function_call_arguments"}.done`, { item_id: item.id, output_index: index, [field]: item[field] }));
      }
      events.push(this.#event("response.output_item.done", { output_index: index, item }));
    }
    const status = this.#finish === "length" ? "incomplete" : "completed";
    events.push(this.#event(`response.${status}`, { response: this.#response(status) }));
    return events;
  }
}
