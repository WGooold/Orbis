import { describe, expect, it } from "vitest";
import { DSH_WEB_TREE_MAX_ENTRIES, dshWebEntries, dshWebEntryText, dshWebTreeOptions, type DshWebLogEvent } from "./dsh-web-history.js";

const event = (seq: number, type: string, data: unknown): DshWebLogEvent => ({ seq, time: 1_000 + seq, type, data });

/** One ordinary turn: turn boundary, question, tool traffic, answer, thinking-only step. */
const turn: DshWebLogEvent[] = [
  event(0, "turn/start", { turn: 1 }),
  event(1, "user/message", { id: "u1", content: [{ type: "text", text: "  第一个 问题\n第二行 " }] }),
  event(2, "tool/call", { callId: "c1", name: "bash" }),
  event(3, "tool/result", { message: { id: "t1", toolCallId: "c1", content: [{ type: "text", text: "命令输出" }] } }),
  event(4, "assistant/message", { message: { id: "a1", content: [{ type: "text", text: "回答" }] } }),
  event(5, "assistant/message", { message: { id: "a2", content: [{ type: "reasoning", text: "只想不答" }] } }),
];

const entries = () => dshWebEntries("s", turn);

describe("DSH Web history tree projection", () => {
  it("projects the linear durable log with native parents and roles the phone can act on", () => {
    const options = dshWebTreeOptions(entries());
    expect(options.map(option => option.value)).toEqual([
      "dsh:s:web:0", "dsh:s:web:1", "dsh:s:web:2", "dsh:s:web:3", "dsh:s:web:4", "dsh:s:web:5",
    ]);
    // Native order is the parent chain: nothing invents a branch that the log does not have.
    expect(options.map(option => option.tree?.parentId)).toEqual([null, "dsh:s:web:0", "dsh:s:web:1", "dsh:s:web:2", "dsh:s:web:3", "dsh:s:web:4"]);
    expect(options.every(option => option.tree?.isOnActivePath === true)).toBe(true);
    expect(options.map(option => option.tree?.isCurrent)).toEqual([false, false, false, false, false, true]);
    expect(options.map(option => option.tree?.role)).toEqual([undefined, "user", undefined, "toolResult", "assistant", "assistant"]);
    // Log-only events, tool traffic and thinking-only steps are detail rows.
    expect(options.map(option => option.tree?.defaultHidden)).toEqual([true, false, true, true, false, true]);
    expect(options.map(option => option.tree?.entryType)).toEqual([
      "turn/start", "message", "tool/call", "message", "message", "message",
    ]);
  });

  it("labels a row from its text, then its tool name, then the native event", () => {
    const options = dshWebTreeOptions(entries());
    expect(options[1]?.label).toBe("第一个 问题 第二行");
    expect(options[3]?.label).toBe("命令输出");
    // Log-only events carry no message: the native event type names the row.
    expect(options[2]?.label).toBe("工具调用");
    expect(options[0]?.label).toBe("回合开始");
    expect(options[5]?.label).toBe("思考");
  });

  it("keeps the exact message text for the editor and previews", () => {
    expect(dshWebEntryText(entries()[1]!)).toBe("第一个 问题\n第二行");
    expect(dshWebEntryText(entries()[0]!)).toBe("");
  });

  it("bounds the tree to the newest window and keeps the parent of a truncated prefix", () => {
    const options = dshWebTreeOptions(entries(), 2);
    expect(options.map(option => option.value)).toEqual(["dsh:s:web:4", "dsh:s:web:5"]);
    // The window start still names its real native parent so the phone can say "older unread".
    expect(options[0]?.tree?.parentId).toBe("dsh:s:web:3");
    expect(options[1]?.tree?.isCurrent).toBe(true);
    expect(DSH_WEB_TREE_MAX_ENTRIES).toBeGreaterThanOrEqual(500);
  });

  it("publishes nothing for an empty session", () => {
    expect(dshWebTreeOptions([])).toEqual([]);
  });
});
