import { describe, expect, it, vi } from "vitest";

// Exercise Windows host defaults on every runner. Native evidence may still
// contain POSIX paths, so its dialect must not depend on these defaults.
vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  return { ...actual, isAbsolute: actual.win32.isAbsolute, relative: actual.win32.relative };
});
import { CODEX_TURN_DIFF_MAX_BYTES, CodexTurnFileChanges } from "./codex-turn-file-changes.js";

const diff = (path = "a.txt", before = "old", after = "new") =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const observe = (tracker: CodexTurnFileChanges, text: string) => tracker.observe({ type: "diff", turnId: "turn", diff: text });

describe("Codex native turn evidence", () => {
  it("replaces whole native revisions rather than adding tool counts", () => {
    const tracker = new CodexTurnFileChanges();
    observe(tracker, diff("a.txt", "A", "B"));
    observe(tracker, diff("a.txt", "A", "C"));
    const result = tracker.comparison("/workspace");
    expect(result).toMatchObject({ unavailable: false, reasons: ["native-file-tools-only"], files: [{
      metadata: { path: "a.txt", changeKind: "modified", additions: 1, deletions: 1, beforeBytes: null, afterBytes: null },
    }] });
    expect(result.files[0]!.text).toContain("-A\n+C\n");
    expect(result.files[0]!.text).not.toContain("+B\n");
  });
  it("clears stale diffs when upstream sends an ambiguous empty revision", () => {
    const tracker = new CodexTurnFileChanges(); observe(tracker, diff()); observe(tracker, "");
    expect(tracker.comparison("/workspace")).toMatchObject({ files: [], unavailable: true, reasons: expect.arrayContaining(["native-diff-empty-or-invalidated"]) });
  });
  it.each(["completed", "failed", "inProgress", "unknown"])("does not infer no changes from a %s file item without a native diff", status => {
    const tracker = new CodexTurnFileChanges(); tracker.observe({ type: "item", turnId: "turn", itemId: "item", status });
    expect(tracker.comparison("/workspace")).toMatchObject({ unavailable: true, reasons: expect.arrayContaining(["native-diff-not-observed"]) });
  });
  it("keeps declined proposals outside actual changes", () => {
    const tracker = new CodexTurnFileChanges(); tracker.observe({ type: "item", turnId: "turn", itemId: "item", status: "declined" });
    expect(tracker.comparison("/workspace")).toMatchObject({ unavailable: false, files: [] });
  });
  it("retains committed text from a partially failed tool", () => {
    const tracker = new CodexTurnFileChanges();
    tracker.observe({ type: "item", turnId: "turn", itemId: "item", status: "failed" }); observe(tracker, diff());
    expect(tracker.comparison("/workspace")).toMatchObject({ unavailable: false, files: [{ metadata: { additions: 1, deletions: 1 } }],
      reasons: expect.arrayContaining(["native-file-operation-incomplete"]) });
  });
  it("reads add/delete/rename and metadata-only binary facts without touching source files", () => {
    const tracker = new CodexTurnFileChanges();
    observe(tracker, [
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n",
      "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n",
      "diff --git a/before.txt b/after.txt\nsimilarity index 100%\nrename from before.txt\nrename to after.txt\n",
      "diff --git a/data.bin b/data.bin\nindex 1111111..2222222 100644\nBinary files a/data.bin and b/data.bin differ\n",
    ].join(""));
    expect(tracker.comparison("/does/not/exist")).toMatchObject({ unavailable: false, files: [
      { metadata: { path: "new.txt", changeKind: "added", additions: 1, deletions: 0 } },
      { metadata: { path: "old.txt", changeKind: "deleted", additions: 0, deletions: 1 } },
      { metadata: { path: "after.txt", oldPath: "before.txt", changeKind: "renamed", additions: 0, deletions: 0 } },
      { metadata: { path: "data.bin", fileKind: "binary", detail: "binary", additions: null, deletions: null } },
    ] });
  });
  it("preserves CRLF, no-newline markers, Unicode paths and leading/trailing spaces", () => {
    const tracker = new CodexTurnFileChanges(); observe(tracker,
      '--- "a/目录/file name.txt"\n+++ "b/目录/file name.txt"\n@@ -1 +1 @@\n- old \r\n+ new \r\n\\ No newline at end of file\n');
    const result = tracker.comparison("/workspace");
    expect(result.files[0]!.metadata.path).toBe("目录/file name.txt");
    expect(result.files[0]!.text).toContain("- old \r\n+ new \r\n\\ No newline at end of file\n");
  });
  it.each([
    "garbage", "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n", diff() + diff(),
    "--- a/a.txt\n+++ b/a.txt\n", diff() + "@@ -1 +1 @@\n-old\n+duplicate\n",
  ])("fails closed for malformed, truncated or ambiguous native revisions", text => {
    const tracker = new CodexTurnFileChanges(); observe(tracker, text);
    expect(tracker.comparison("/workspace")).toMatchObject({ unavailable: true, files: [] });
  });
  it("bounds native revisions and replaces an oversized revision with a later valid one", () => {
    const tracker = new CodexTurnFileChanges(); observe(tracker, "X".repeat(CODEX_TURN_DIFF_MAX_BYTES + 1));
    expect(tracker.comparison("/workspace")).toMatchObject({ unavailable: true, reasons: expect.arrayContaining(["native-diff-budget"]) });
    observe(tracker, diff()); expect(tracker.comparison("/workspace").unavailable).toBe(false);
  });
  it.each([["/workspace", "/workspace/src/a.txt", "src/a.txt"], ["C:\\project", "C:\\project\\src\\a.txt", "src/a.txt"]])(
    "normalizes native absolute display paths without authorizing disk reads", (cwd, path, expected) => {
      const tracker = new CodexTurnFileChanges();
      observe(tracker, `--- ${JSON.stringify(`a/${path}`)}\n+++ ${JSON.stringify(`b/${path}`)}\n@@ -1 +1 @@\n-old\n+new\n`);
      expect(tracker.comparison(cwd).files[0]!.metadata.path).toBe(expected);
    });
});
