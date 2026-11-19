import { describe, expect, it } from "vitest";
import { ChatMessageSchema, type ChatMessage } from "./index.js";
import { downgradeMessageForLegacy, normalizeCodexMessage, renderStreamingMarkdown } from "./message-rendering.js";

const message = (text: string, role: "assistant" | "user" = "assistant"): ChatMessage => ({
  messageId: "m1", role, timestamp: 1, content: [{ type: "text", text }],
});
const referenceId = `orbis-message-file:${"a".repeat(64)}`;
const resolve = (path: string) => ({ referenceId, key: path });
const source = String.raw`:codex-file-citation{path="C:\Users\25892\Desktop\中文\draft.md" purpose=source line_range_start=18 line_range_end=20}`;
const output = ':codex-file-citation{path="/work/final report.md" purpose=output}';

describe("MSG-RENDER-01: shared Codex Markdown projection", () => {
  it("keeps inline Markdown in the same paragraph and groups duplicate outputs", () => {
    const raw = message(`🙂 Read **${source}** first.\n\n${output}\n${output}`);
    const projected = normalizeCodexMessage(raw, resolve);
    expect(projected.content).toEqual([
      { type: "text", text: `🙂 Read **[draft.md:18–20](<${referenceId}>)** first.` },
      { type: "render", renderKind: "file_reference", text: "final report.md", purpose: "output", file: { referenceId, fileName: "final report.md" } },
    ]);
    expect(ChatMessageSchema.parse(projected)).toEqual(projected);
    expect(raw.content[0]).toMatchObject({ text: expect.stringContaining(source) });
    expect(JSON.stringify(projected)).not.toContain("/work/");
    expect(JSON.stringify(downgradeMessageForLegacy(projected))).not.toMatch(/orbis-message-file|codex-file-citation/);
  });

  it("recognizes the older bracket form, optional purpose and path line suffix", () => {
    const raw = message(':codex-file-citation[codex-file-citation]{path="src/file.kt:42:3"}');
    expect(normalizeCodexMessage(raw, resolve).content[0]).toMatchObject({ text: `[file.kt:42](<${referenceId}>)` });
  });

  it("leaves nested fences, indented code, links, escaped markers and raw HTML literal", () => {
    for (const text of [`\`${source}\``, `> ~~~txt\n> ${source}\n> ~~~`, `    ${source}`, `<span>${source}</span>`,
      `<!-- ${source} -->`, `[${source}](https://example.test)`, `[file](<${source}>)`, `[ref]: <${source}>`, `\\${source}`, `\\:${source}`]) {
      const raw = message(text);
      expect(normalizeCodexMessage(raw, resolve), text).toBe(raw);
    }
    const user = message(source, "user");
    expect(normalizeCodexMessage(user, resolve)).toBe(user);
  });

  it("buffers an unfinished directive, restores malformed text and keeps following prose", () => {
    expect(renderStreamingMarkdown("See :codex-file")).toEqual({ text: "See ", pending: true });
    expect(renderStreamingMarkdown(`${output.slice(0, -1)}`)).toEqual({ text: "", pending: true });
    expect(renderStreamingMarkdown(`See ${output} now.`, resolve)).toEqual({ text: "See final report.md now.", pending: false });
    const malformed = 'See :codex-file-citation{path="unterminated\nAnd then this.';
    const raw = message(malformed);
    expect(normalizeCodexMessage(raw, resolve)).toBe(raw);
    expect(normalizeCodexMessage(message(`${malformed}\n${output}`), resolve).content.at(-1)).toMatchObject({ type: "render" });
  });
});
