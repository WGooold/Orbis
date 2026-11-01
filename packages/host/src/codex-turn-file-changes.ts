import { createHash } from "node:crypto";
import { isAbsolute, relative, win32 } from "node:path";
import { formatPatch, parsePatch } from "diff";
import type { FileChangeMetadata } from "@orbis/protocol";

/** Private adapter evidence. Proposed patches must never enter this channel. */
export type CodexFileChangeEvidence =
  | { type: "diff"; turnId: string; diff: string }
  | { type: "item"; turnId: string; itemId: string; status: string };
export type NativeFileComparison = { metadata: FileChangeMetadata; text?: string };
export type NativeTurnComparison = { files: NativeFileComparison[]; reasons: string[]; unavailable: boolean };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
export const CODEX_TURN_DIFF_MAX_BYTES = 8 * 1024 * 1024;

function displayPath(value: string, cwd: string): string {
  const bare = value.replace(/^[ab]\//u, "");
  const windows = win32.isAbsolute(bare) && !isAbsolute(bare);
  const path = windows ? win32 : { isAbsolute, relative };
  if (!path.isAbsolute(bare)) return bare;
  const inside = path.relative(cwd, bare);
  return inside && inside !== ".." && !inside.startsWith(windows ? "..\\" : "../") && !path.isAbsolute(inside)
    ? windows ? inside.replaceAll("\\", "/") : inside : bare;
}

/** Consume whole native revisions, never sum per-tool +/- counts or read today's workspace. */
export class CodexTurnFileChanges {
  #diff: string | undefined;
  #problem: string | undefined;
  #itemBudget = false;
  readonly #items = new Map<string, string>();

  observe(event: CodexFileChangeEvidence): void {
    if (event.type === "item") {
      if (!event.itemId || event.itemId.length > 256 || event.status.length > 64) { this.#itemBudget = true; return; }
      if (!this.#items.has(event.itemId) && this.#items.size >= 20_000) { this.#itemBudget = true; return; }
      this.#items.set(event.itemId, event.status);
      return;
    }
    // An empty native revision can also mean that upstream invalidated its tracker.
    // Clear the previous result; neither an empty string nor stale text proves zero changes.
    this.#diff = undefined;
    this.#problem = event.diff.length === 0 ? "native-diff-empty-or-invalidated"
      : Buffer.byteLength(event.diff) > CODEX_TURN_DIFF_MAX_BYTES ? "native-diff-budget" : undefined;
    if (!this.#problem) {
      let offset = 0, lines = 0;
      while ((offset = event.diff.indexOf("\n", offset)) >= 0) {
        if (++lines > 200_000) { this.#problem = "native-diff-budget"; break; }
        offset++;
      }
    }
    if (!this.#problem) this.#diff = event.diff;
  }

  comparison(cwd: string): NativeTurnComparison {
    const reasons = ["native-file-tools-only"];
    const unavailable = (reason: string): NativeTurnComparison => ({ files: [], reasons: [...reasons, reason], unavailable: true });
    if (this.#itemBudget) return unavailable("native-item-budget");
    if (this.#problem) return unavailable(this.#problem);
    if (this.#diff === undefined) {
      return [...this.#items.values()].some(status => status !== "declined")
        ? unavailable("native-diff-not-observed") : { files: [], reasons, unavailable: false };
    }
    try {
      const patches = parsePatch(this.#diff);
      if (!patches.length || patches.length > 20_000) return unavailable("native-diff-unrepresentable");
      const files: NativeFileComparison[] = [], paths = new Set<string>();
      for (const patch of patches) {
        if (!patch.oldFileName || !patch.newFileName || patch.isCopy) return unavailable("native-diff-unrepresentable");
        const added = patch.oldFileName === "/dev/null" || patch.isCreate === true;
        const deleted = patch.newFileName === "/dev/null" || patch.isDelete === true;
        if (added && deleted) return unavailable("native-diff-unrepresentable");
        const oldPath = displayPath(patch.oldFileName, cwd), nextPath = displayPath(patch.newFileName, cwd);
        const path = deleted ? oldPath : nextPath;
        if ([oldPath, nextPath].some(value => !value || value.length > 4096 || value.includes("\0")) || paths.has(path)) return unavailable("native-diff-unrepresentable");
        paths.add(path);
        let additions = 0, deletions = 0, oldEnd = 0, nextEnd = 0;
        for (const hunk of patch.hunks) {
          for (const number of [hunk.oldStart, hunk.newStart, hunk.oldLines, hunk.newLines]) {
            if (!Number.isSafeInteger(number) || number < 0) return unavailable("native-diff-unrepresentable");
          }
          const oldStart = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
          const nextStart = hunk.newLines ? hunk.newStart - 1 : hunk.newStart;
          if (oldStart < oldEnd || nextStart < nextEnd || !Number.isSafeInteger(oldStart + hunk.oldLines) || !Number.isSafeInteger(nextStart + hunk.newLines)) {
            return unavailable("native-diff-unrepresentable");
          }
          oldEnd = oldStart + hunk.oldLines; nextEnd = nextStart + hunk.newLines;
          additions += hunk.lines.filter(line => line.startsWith("+")).length;
          deletions += hunk.lines.filter(line => line.startsWith("-")).length;
        }
        const renamed = !added && !deleted && oldPath !== nextPath;
        if (!patch.isBinary && !added && !deleted && !renamed && patch.oldMode === patch.newMode && !additions && !deletions) {
          return unavailable("native-diff-unrepresentable");
        }
        const text = patch.isBinary ? undefined : formatPatch(patch);
        const metadata: FileChangeMetadata = {
          fileId: sha(path), path, ...(renamed ? { oldPath } : {}),
          changeKind: added ? "added" : deleted ? "deleted" : renamed ? "renamed" : "modified",
          fileKind: patch.isBinary ? "binary" : "text",
          additions: patch.isBinary ? null : additions, deletions: patch.isBinary ? null : deletions,
          beforeBytes: null, afterBytes: null, contentVersion: sha(`codex-native-v1\0${text ?? this.#diff}`),
          detail: patch.isBinary ? "binary" : "available",
        };
        files.push({ metadata, ...(text === undefined ? {} : { text }) });
      }
      // The protocol does not expose all core AppliedPatchDelta fields. Pure renames,
      // empty files and a reset tracker cannot be reconstructed from missing text.
      if ([...this.#items.values()].some(status => status !== "completed" && status !== "declined")) reasons.push("native-file-operation-incomplete");
      return { files, reasons, unavailable: false };
    } catch { return unavailable("native-diff-unrepresentable"); }
  }
}
