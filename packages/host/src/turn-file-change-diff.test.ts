import { describe, expect, it } from "vitest";
import { applyPatch } from "diff";
import { compareTurnText, renderTurnDiff } from "./turn-file-change-diff.js";

describe("immutable line comparison", () => {
  it.each([
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["a\r\nb\r\n", "a\nb\r\n"],
    ["a\n", "a"],
    ["", "new\n"],
    ["old\n", ""],
    [Array.from({length: 30}, (_, i) => `${i}\n`).join(""), Array.from({length: 30}, (_, i) => `${i === 2 || i === 20 ? "new" : i}\n`).join("")],
  ])("round trips whitespace and newline semantics through a mature patch parser", async (before, after) => {
    const index = await compareTurnText(before, after);
    expect(index).toBeDefined();
    const patch = renderTurnDiff("example.txt", before, after, index!, true, true);
    expect(applyPatch(before, patch)).toBe(after);
  });
  it("terminates costly comparisons without blocking the main event loop", async () => {
    let ticked = false; setTimeout(() => { ticked = true; }, 0);
    const before = Array.from({length: 20000}, (_, i) => `old-${i}\n`).join("");
    const after = Array.from({length: 20000}, (_, i) => `new-${i}\n`).join("");
    expect(await compareTurnText(before, after, 1)).toBeUndefined(); expect(ticked).toBe(true);
  });
});
