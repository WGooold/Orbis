import { object, text, type Obj } from "./provider-proxy-config.js";
import { responsesToChat } from "./codex-chat.js";
import { ProviderError } from "./provider-error.js";

function parts(value: unknown): Obj[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  return (Array.isArray(value) ? value : []).map(entry => {
    const part = object(entry);
    if (part.type === "text") return part;
    if (part.type === "image_url") {
      const url = text(object(part.image_url).url);
      if (url.startsWith("data:")) {
        const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(url);
        if (!match) throw new ProviderError("Invalid base64 image");
        return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
      }
      return { type: "image", source: { type: "url", url } };
    }
    throw new ProviderError("Anthropic conversion does not support this attachment format");
  });
}
export function responsesToAnthropic(input: Obj, model: string, options: Obj = {}): ReturnType<typeof responsesToChat> {
  const converted = responsesToChat(input, model, options);
  const chat = converted.body; const messages: Obj[] = []; const system: Obj[] = [];
  for (const entry of chat.messages as Obj[]) {
    if (["system", "developer"].includes(text(entry.role))) { system.push(...parts(entry.content)); continue; }
    const role = entry.role === "assistant" ? "assistant" : "user";
    const content: Obj[] = entry.role === "tool" ? [{ type: "tool_result", tool_use_id: entry.tool_call_id, content: text(entry.content) }] : parts(entry.content);
    for (const call of (Array.isArray(entry.tool_calls) ? entry.tool_calls : []).map(object)) {
      const fn = object(call.function);
      content.push({ type: "tool_use", id: call.id, name: fn.name, input: JSON.parse(text(fn.arguments)) as unknown });
    }
    if (!content.length) continue;
    const last = messages.at(-1);
    if (last?.role === role) (last.content as Obj[]).push(...content); else messages.push({ role, content });
  }
  const body: Obj = { model: chat.model, messages, max_tokens: input.max_output_tokens ?? options.maxTokens ?? 8192, stream: input.stream === true };
  if (system.length) body.system = system;
  if (converted.tools.tools.length) body.tools = converted.tools.tools.map(tool => { const fn = object(tool.function); return { name: fn.name, description: fn.description, input_schema: fn.parameters }; });
  if (chat.temperature !== undefined) body.temperature = chat.temperature;
  if (chat.top_p !== undefined) body.top_p = chat.top_p;
  if (chat.tool_choice) {
    const choice = chat.tool_choice;
    body.tool_choice = typeof choice === "string" ? { type: choice === "required" ? "any" : choice } : { type: "tool", name: object(object(choice).function).name };
  }
  if (options.thinkingBudget) body.thinking = { type: "enabled", budget_tokens: options.thinkingBudget };
  return { body, tools: converted.tools };
}

/** Normalize Anthropic events to the existing tool-aware Responses stream encoder. */
export class AnthropicChat {
  #usage: Obj = {}; #reason = ""; #toolIndexes = new Set<number>(); #arguments = new Set<number>();
  push(value: Obj): Obj[] {
    const type = text(value.type);
    if (type === "error") throw new ProviderError("Anthropic upstream returned an error");
    if (type === "message_start") { this.#usage = object(object(value.message).usage); return [{ choices: [] }]; }
    if (type === "content_block_start") {
      const block = object(value.content_block); const index = Number(value.index);
      if (block.type === "tool_use") {
        this.#toolIndexes.add(index);
        const initial = object(block.input);
        if (Object.keys(initial).length) this.#arguments.add(index);
        return [{ choices: [{ delta: { tool_calls: [{ index, id: block.id, function: { name: block.name, arguments: Object.keys(initial).length ? JSON.stringify(initial) : "" } }] } }] }];
      }
      return [{ choices: [{ delta: { content: text(block.text), reasoning_content: text(block.thinking) } }] }];
    }
    if (type === "content_block_delta") {
      const delta = object(value.delta); const index = Number(value.index);
      if (delta.type === "input_json_delta") { this.#arguments.add(index); return [{ choices: [{ delta: { tool_calls: [{ index, function: { arguments: delta.partial_json } }] } }] }]; }
      return [{ choices: [{ delta: { content: text(delta.text), reasoning_content: text(delta.thinking) } }] }];
    }
    if (type === "content_block_stop" && this.#toolIndexes.has(Number(value.index)) && !this.#arguments.has(Number(value.index))) return [{ choices: [{ delta: { tool_calls: [{ index: value.index, function: { arguments: "{}" } }] } }] }];
    if (type === "message_delta") { this.#reason = text(object(value.delta).stop_reason); this.#usage = { ...this.#usage, ...object(value.usage) }; return []; }
    if (type === "message_stop") {
      const input = Number(this.#usage.input_tokens ?? 0) + Number(this.#usage.cache_read_input_tokens ?? 0) + Number(this.#usage.cache_creation_input_tokens ?? 0);
      const output = Number(this.#usage.output_tokens ?? 0);
      return [{ choices: [{ delta: {}, finish_reason: ({ end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length" } as Record<string, string>)[this.#reason] ?? "error" }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: this.#usage.cache_read_input_tokens ?? 0 } } }];
    }
    return [];
  }
  complete(message: Obj): Obj[] {
    const chunks = this.push({ type: "message_start", message });
    for (const [index, part] of (Array.isArray(message.content) ? message.content : []).entries()) chunks.push(...this.push({ type: "content_block_start", index, content_block: part }), ...this.push({ type: "content_block_stop", index }));
    chunks.push(...this.push({ type: "message_delta", delta: { stop_reason: message.stop_reason }, usage: message.usage }), ...this.push({ type: "message_stop" }));
    return chunks;
  }
}
