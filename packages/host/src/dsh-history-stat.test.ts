import { appendFileSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dshLogStatKey } from "./dsh-history.js";

describe("DSH log change detection", () => {
  // DSH 只给整份读；"没变就不重读"必须靠文件事实，否则每次 sync 都要付一次全量解析。
  it("changes only when the log file actually grows or is replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-log-"));
    mkdirSync(join(root, "proj", "session-abc"), { recursive: true });
    const file = join(root, "proj", "session-abc", "session.v4.jsonl.zstd");
    writeFileSync(file, "frame-one");
    const first = dshLogStatKey(file);
    expect(dshLogStatKey(file)).toBe(first);

    await new Promise((resolve) => setTimeout(resolve, 12));
    appendFileSync(file, "frame-two");
    expect(dshLogStatKey(file)).not.toBe(first);
    expect(statSync(file).size).toBeGreaterThan(9);

    expect(dshLogStatKey(join(root, "missing.v4.jsonl.zstd"))).toBeUndefined();
    expect(dshLogStatKey(undefined)).toBeUndefined();
  });
});
