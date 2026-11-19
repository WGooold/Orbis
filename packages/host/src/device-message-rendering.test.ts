import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISPLAY_PROJECTION_VERSION, RuntimeEventSchema, selectSessionSyncSnapshot, type ChatMessage, type RuntimeEvent } from "@orbis/protocol";
import { DeviceMessageRendering } from "./device-message-rendering.js";
import { MessageFileReferences } from "./message-file-references.js";

const cwd = process.cwd();
const native = ':codex-file-citation{path="doc/final answer.md" purpose=output}';
const assistant = (text = native): ChatMessage => ({ messageId: "m1", role: "assistant", timestamp: 1, content: [{ type: "text", text }] });
function renderer() {
  const engine = new DeviceMessageRendering(new MessageFileReferences());
  return (event: RuntimeEvent, rich: boolean, observed = false, codex = true) => {
    if (observed) engine.observe("runtime", event);
    const envelope = engine.project(rich ? "phone" : "old", { type: "runtime.event", runtimeId: "runtime", event }, { rich, codex, cwd });
    return RuntimeEventSchema.parse((envelope as { event: unknown }).event);
  };
}

describe("MSG-RENDER-01 device message rendering", () => {
  it("gates rich blocks and does not treat another backend's Markdown as a Codex directive", () => {
    const render = renderer(), event = { type: "message.finished", message: assistant() } as const;
    expect(render(event, true)).toMatchObject({ message: { content: [{ type: "render", renderKind: "file_reference", text: "final answer.md",
      file: { fileName: "final answer.md", referenceId: expect.stringMatching(/^orbis-message-file:[a-f0-9]{64}$/) } }] } });
    expect(render(event, false)).toEqual({ ...event, message: assistant("final answer.md") });
    expect(render(event, true, false, false)).toEqual(event);
  });

  it("uses the output file card for an available image path, with no path or action for older clients", () => {
    const engine = new DeviceMessageRendering(new MessageFileReferences());
    const message: ChatMessage = { ...assistant(), content: [{ type: "render", renderKind: "codex_generated_image", text: "生成图片暂不可显示" }] };
    const envelope = { type: "runtime.event", runtimeId: "runtime", event: { type: "message.finished", message } };
    const path = join(cwd, "image.png");
    const project = (rich: boolean, generatedImagePath?: () => string) => engine.project("phone", envelope, { codex: true, rich, ...(generatedImagePath ? { generatedImagePath } : {}) });
    expect(project(true, () => path)).toMatchObject({ event: { message: { content: [{ type: "render", renderKind: "file_reference", purpose: "output",
      text: "image.png", file: { fileName: "image.png", referenceId: expect.stringMatching(/^orbis-message-file:/) } }] } } });
    expect(JSON.stringify(project(true, () => path))).not.toContain(path);
    expect(project(true)).toEqual(envelope);
    expect(project(false, () => path)).toMatchObject({ event: { message: { content: [{ type: "text", text: "生成图片暂不可显示" }] } } });
  });

  it("withholds split directives even when no device saw the beginning; repeated projection does not append twice", () => {
    const render = renderer();
    const first = { type: "message.delta", messageId: "m1", delta: "Look here: :codex-file" } as const;
    expect(render(first, false, true)).toMatchObject({ delta: "Look here: " });
    const second = { type: "message.delta", messageId: "m1", delta: '-citation{path="file.txt:3"} done.' } as const;
    expect(render(second, true, true)).toMatchObject({ delta: "file.txt:3 done." });
    expect(render(second, false)).toMatchObject({ delta: "file.txt:3 done." });
  });

  it("projects history, live patches and explicit entries without changing the source batch", () => {
    const message = assistant();
    const entry = { entryId: "m1", parentId: null, type: "message", timestamp: "2026-11-19T00:00:00Z", data: { message } };
    const history = selectSessionSyncSnapshot([entry], "session", "m1", { sessionId: "session", syncId: "s", range: "preview" });
    const before = structuredClone(history);
    expect(renderer()(history, true)).toMatchObject({ display: { projectionVersion: DISPLAY_PROJECTION_VERSION,
      entries: [{ message: { content: [{ type: "render" }] } }] } });
    expect(renderer()(history, false)).toMatchObject({ display: { projectionVersion: 3,
      entries: [{ message: { content: [{ type: "text", text: "final answer.md" }] } }] } });
    expect(history).toEqual(before);
    const patch = { type: "session.patch", sessionId: "session", source: { epoch: "a", seq: 2, ready: true }, baseSeq: 1, seq: 2,
      checkpointId: "a:2", head: { leafId: "m1" }, headCompleteness: "complete", live: { complete: true, tools: [], turn: null,
        messages: [{ message: assistant("text :codex-file-citation{path="), finished: false, contentComplete: false }] } } as const;
    expect(renderer()(RuntimeEventSchema.parse(patch), true)).toMatchObject({ live: { messages: [{ message: assistant("text ") }] } });
    expect(renderer()({ type: "session.entry.result", requestId: "r", entryId: "m1", entry }, false)).toMatchObject({ entry: { data: { message: assistant("final answer.md") } } });
  });
});
