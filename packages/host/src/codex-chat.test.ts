import { describe, it, expect } from "vitest";
import { responsesToChat, ChatResponses } from "./codex-chat.js";
import { responsesToAnthropic, AnthropicChat } from "./codex-anthropic.js";
import { object } from "./provider-proxy-config.js";

describe("Codex protocol conversion", () => {
  it("retains developer instructions, images, tool outputs and reasoning history", () => {
    const { body } = responsesToChat({ instructions: "system", input: [
      { role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "planning" }] },
      { type: "function_call", call_id: "c", name: "read", arguments: '{"path":"test"}' },
      { type: "function_call_output", call_id: "c", output: "file data" },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
    ], reasoning: { effort: "high" } }, "upstream", { supportsDeveloperRole: false, supportsReasoningEffort: true });
    expect(body.messages).toEqual([
      { role: "system", content: "system\n\nrules" },
      { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, reasoning_content: "planning", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: '{"path":"test"}' } }] },
      { role: "tool", tool_call_id: "c", content: "file data" }, { role: "assistant", content: "answer" },
    ]);
    expect(body).toMatchObject({ model: "upstream", reasoning_effort: "high" });
  });
  it("round-trips namespace, custom grammar and tool search tools without losing their type", () => {
    const { body, tools } = responsesToChat({ input: "test", tools: [
      { type: "namespace", name: "functions", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      { type: "custom", name: "apply_patch", format: { type: "grammar", definition: "raw patch" } }, { type: "tool_search" },
    ] }, "model");
    expect(JSON.stringify(body.tools)).toContain("Original tool definition");
    const stream = new ChatResponses(tools, "model");
    stream.push({ choices: [{ delta: { tool_calls: [
      { index: 1, id: "patch", function: { name: "apply_", arguments: '{"input":' } },
      { index: 0, id: "read", function: { name: "functions__read", arguments: "{}" } },
    ] } }] });
    stream.push({ choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "patch", arguments: '"*** Begin Patch\\n*** End Patch"}' } }] }, finish_reason: "tool_calls" }] });
    const response = object(stream.finish().at(-1)!.response);
    expect(response.output).toMatchObject([
      { type: "function_call", namespace: "functions", name: "read", call_id: "read", arguments: "{}" },
      { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: "*** Begin Patch\n*** End Patch" },
    ]);
  });
  it("streams text/reasoning with stable IDs, indexes, monotonic sequence and usage", () => {
    const { tools } = responsesToChat({ input: "hello" }, "model");
    const stream = new ChatResponses(tools, "model");
    const events = [
      ...stream.push({ choices: [{ delta: { content: "<thi" } }] }),
      ...stream.push({ choices: [{ delta: { content: "nk>plan</think>hello " } }] }),
      ...stream.push({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] }),
      ...stream.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
      ...stream.finish(),
    ];
    expect(events.map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
    const response = object(events.at(-1)!.response);
    expect(response.output).toMatchObject([{ type: "reasoning", summary: [{ text: "plan" }] }, { type: "message", content: [{ text: "hello world" }] }]);
    expect(response.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
    for (const event of events.filter(e => e.item_id)) expect(event.item_id).toBe(object((response.output as unknown[])[event.output_index as number]).id);
  });
  it("rejects truncated streams and malformed tools instead of completing or executing them", () => {
    const { tools } = responsesToChat({ input: "x", tools: [{ type: "custom", name: "patch" }] }, "m");
    const stream = new ChatResponses(tools, "m");
    stream.push({ choices: [{ delta: { content: "partial" } }] });
    expect(() => stream.finish()).toThrow("finish reason");
    const bad = new ChatResponses(tools, "m");
    bad.push({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "patch", arguments: "broken" } }] }, finish_reason: "tool_calls" }] });
    expect(() => bad.finish()).toThrow("invalid JSON");
    expect(() => responsesToChat({ previous_response_id: "external", input: [] }, "m")).toThrow("stateless");
    expect(responsesToChat({ input: [], tools: [{ type: "web_search" }], tool_choice: "auto" }, "m").body).not.toHaveProperty("tools");
  });
  it("bridges Anthropic messages, images, tool results and streamed JSON deltas", () => {
    const converted = responsesToAnthropic({ instructions: "system", tools: [{ type: "function", name: "read", parameters: { type: "object" } }], input: [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "result" },
    ] }, "claude");
    expect(converted.body).toMatchObject({ model: "claude", system: [{ type: "text", text: "system" }], messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "result" }] },
    ] });
    const parser = new AnthropicChat(); const stream = new ChatResponses(converted.tools, "claude");
    for (const event of [
      { type: "message_start", message: { usage: { input_tokens: 8, cache_read_input_tokens: 2 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "next", name: "read", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file":"a"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }, { type: "message_stop" },
    ]) for (const chunk of parser.push(event)) stream.push(chunk);
    expect(object(stream.finish().at(-1)!.response)).toMatchObject({ status: "completed", usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: "function_call", call_id: "next", name: "read", arguments: '{"file":"a"}' }] });
  });
  it("keeps parallel tool results adjacent before attaching structured media", () => {
    const { body } = responsesToChat({ input: [
      { type: "function_call", call_id: "a", name: "read", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: { content: [{ type: "image", mimeType: "image/png", data: "IMAGE_A" }] } },
      { type: "function_call_output", call_id: "b", output: JSON.stringify({ content: [{ type: "input_file", file_id: "file_1" }, { type: "input_audio", input_audio: { format: "wav", data: "AUDIO_B" } }] }) },
    ] }, "model");
    const messages = body.messages as Record<string, unknown>[];
    expect(messages.map(row => row.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(JSON.stringify(messages.slice(1, 3))).not.toContain("IMAGE_A");
    expect(messages[3]!.content).toMatchObject([{ type: "text" }, { type: "image_url", image_url: { url: "data:image/png;base64,IMAGE_A" } }, { type: "text" }, { type: "file", file: { file_id: "file_1" } }, { type: "input_audio" }]);
  });
  it("preserves reasoning_details and avoids unknown models' reasoning_effort parameter", () => {
    const { body, tools } = responsesToChat({ input: "test", reasoning: { effort: "high" } }, "gpt-4o");
    expect(body).not.toHaveProperty("reasoning_effort");
    const stream = new ChatResponses(tools, "MiniMax");
    stream.push({ choices: [{ message: { reasoning_details: [{ type: "reasoning_text", text: "plan" }], content: "answer" }, finish_reason: "stop" }] });
    expect(object(stream.finish().at(-1)!.response).output).toMatchObject([{ type: "reasoning", summary: [{ text: "plan" }] }, { type: "message" }]);
  });
});
