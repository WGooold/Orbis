import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

  // SC121: classify on completed explicit file destinations, not textual hints or streaming/tool output.
  it("projects workspace deliveries once and leaves non-files and external locations alone", () => {
    const render = renderer();
    const text = ["[报告](reports/summary.pdf)", "![截图](./shot.png)", "[重复](shot.png)",
      `[同一张图](<${pathToFileURL(join(cwd, "shot.png")).href}>)`, "[视频](./clip.mp4)", "[表格](data.xlsx)",
      "[完整产物](bundle.zip)", "只是提到 image.jpeg", "`[代码](inside.txt)`", "```md\n[示例](code.png)\n```",
      "<span>[片段](tag.pdf)</span>", "[外链](https://example.invalid/foreign.pdf)", "[虚拟沙箱](sandbox:/mnt/data/output.pdf)",
      "[父目录](%2e%2e/private.pdf)", `[外部路径](<${pathToFileURL(resolve(cwd, "../external.pdf")).href}>)`,
      "![数据](data:image/png;base64,AAAB)", "[站外](//example.invalid/demo.mp4)"].join("\n\n");
    const event = { type: "message.finished", message: assistant(text) } as const;
    const result = render(event, true, false, false);
    expect(result.type).toBe("message.finished");
    if (result.type !== "message.finished") throw new Error("expected completed reply");
    expect(result.message.content.filter(block => block.type === "render").map(block => block.file?.fileName))
      .toEqual(["summary.pdf", "shot.png", "clip.mp4", "data.xlsx", "bundle.zip"]);
    expect(result.message.content[0]).toEqual(event.message.content[0]);
    expect(render(event, false, false, false)).toEqual(event);
    expect(render({ ...event, type: "message.started" }, true, false, false)).toEqual({ ...event, type: "message.started" });
    expect(render({ ...event, message: { ...event.message, role: "user" } }, true, false, false)).toEqual({ ...event, message: { ...event.message, role: "user" } });
    expect(render({ ...event, message: { ...event.message, role: "tool" } }, true, false, false)).toEqual({ ...event, message: { ...event.message, role: "tool" } });
  });

  it("preserves file identities across history and avoids duplicate output cards, without hiding source citations", () => {
    const render = renderer();
    const message = assistant(':codex-file-citation{path="doc/summary.pdf" purpose=output}\n[报告](doc/summary.pdf)\n' +
      ':codex-file-citation{path="notes.txt" purpose=source}\n[notes](notes.txt)');
    const event = { type: "message.finished", message } as const;
    const live = render(event, true);
    if (live.type !== "message.finished") throw new Error("expected finished reply");
    const output = live.message.content.filter(block => block.type === "render");
    expect(output.map(block => block.file?.fileName)).toEqual(["summary.pdf", "notes.txt"]);
    const entry = { entryId: "m1", parentId: null, type: "message", timestamp: "2026-11-21T00:00:00Z", data: { message } };
    const history = selectSessionSyncSnapshot([entry], "session", "m1", { sessionId: "session", syncId: "s", range: "preview" });
    expect(render(history, true)).toMatchObject({ display: { entries: [{ message: live.message }] } });
    expect(render({ type: "session.entry.result", requestId: "r", entryId: "m1", entry }, true))
      .toMatchObject({ entry: { data: { message: live.message } } });
  });
});
