import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

export type ChangeRun = { kind: "context" | "add" | "delete"; count: number };
export type TextComparison = { runs: ChangeRun[]; additions: number; deletions: number };
const require = createRequire(import.meta.url);
const diffModule = require.resolve("diff");
/** The worker's CPU/memory and wall time are bounded independently of the Host event loop. */
export function compareTurnText(before: string, after: string, budgetMs = 100): Promise<TextComparison | undefined> {
  return new Promise(resolve => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { diffLines } = require(workerData.module);
      const changes = diffLines(workerData.before, workerData.after, {
        timeout: workerData.budget, maxEditLength: 20000,
        ignoreWhitespace: false, stripTrailingCr: false, newlineIsToken: false,
      });
      if (!changes) parentPort.postMessage(null);
      else parentPort.postMessage({ runs: changes.map(c => ({
        kind: c.added ? 'add' : c.removed ? 'delete' : 'context', count: c.count,
      })), additions: changes.filter(c => c.added).reduce((n,c) => n+c.count,0),
      deletions: changes.filter(c => c.removed).reduce((n,c) => n+c.count,0) });
    `, { eval: true, workerData: { module: diffModule, before, after, budget: budgetMs },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    let done = false;
    const finish = (result?: TextComparison): void => { if (done) return; done = true; clearTimeout(timer); void worker.terminate(); resolve(result); };
    const timer = setTimeout(() => finish(), Math.max(1_000, budgetMs + 500)); timer.unref();
    worker.once("message", value => finish(value ?? undefined));
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
  });
}

function lines(text: string): string[] { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
function quotePath(path: string): string { return JSON.stringify(path); }
/** Render only from immutable contents and the exact run index used for summary counts. */
export function renderTurnDiff(path: string, before: string, after: string, comparison: TextComparison,
  existsBefore: boolean, existsAfter: boolean): string {
  const oldLines = lines(before), newLines = lines(after);
  const pieces: string[] = [`--- ${existsBefore ? quotePath(`a/${path}`) : "/dev/null"}\n+++ ${existsAfter ? quotePath(`b/${path}`) : "/dev/null"}\n`];
  type Segment = { run: ChangeRun; old: number; next: number; start: number; end: number };
  const segments: Segment[] = [];
  let old = 0, next = 0, position = 0;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const run of comparison.runs) {
    segments.push({ run, old, next, start: position, end: position + run.count });
    if (run.kind !== "context") {
      const range = { start: Math.max(0, position - 3), end: position + run.count + 3 };
      const previous = ranges.at(-1);
      if (previous && range.start <= previous.end) previous.end = range.end; else ranges.push(range);
    }
    position += run.count;
    if (run.kind !== "add") old += run.count;
    if (run.kind !== "delete") next += run.count;
  }
  let segmentCursor = 0;
  for (const range of ranges) {
    range.end = Math.min(position, range.end);
    while (segmentCursor < segments.length && segments[segmentCursor]!.end <= range.start) segmentCursor++;
    const selected: Segment[] = [];
    for (let i = segmentCursor; i < segments.length && segments[i]!.start < range.end; i++) selected.push(segments[i]!);
    const first = selected[0]; if (!first) continue;
    const offset = Math.max(0, range.start - first.start);
    const oldStart = first.old + (first.run.kind === "add" ? 0 : offset);
    const newStart = first.next + (first.run.kind === "delete" ? 0 : offset);
    let oldCount = 0, newCount = 0;
    const body: string[] = [];
    for (const segment of selected) {
      const from = Math.max(0, range.start - segment.start), to = Math.min(segment.run.count, range.end - segment.start);
      if (segment.run.kind !== "add") oldCount += to - from;
      if (segment.run.kind !== "delete") newCount += to - from;
      for (let i = from; i < to; i++) {
        const line = segment.run.kind === "delete" ? oldLines[segment.old + i]! : newLines[segment.next + i]!;
        body.push((segment.run.kind === "add" ? "+" : segment.run.kind === "delete" ? "-" : " ") + line);
        if (!line.endsWith("\n")) body.push("\n\\ No newline at end of file\n");
      }
    }
    pieces.push(`@@ -${oldCount ? oldStart + 1 : oldStart},${oldCount} +${newCount ? newStart + 1 : newStart},${newCount} @@\n`, body.join(""));
  }
  return pieces.join("");
}
