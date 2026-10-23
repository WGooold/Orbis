import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dshDecodeFrames, dshEventsFromText, dshReadTail } from "./dsh-history.js";

/** DSH v4 的写法：每次追加一个**独立** zstd 帧，帧内是若干 JSONL 行。 */
const frame = (events: Array<{ seq: number; type: string; data: unknown }>): Buffer =>
  zstdCompressSync(Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8"));

describe("incremental DSH log read", () => {
  it("decodes appended frames without touching earlier bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "dsh-inc-"));
    mkdirSync(join(root, "proj", "session-x"), { recursive: true });
    const file = join(root, "proj", "session-x", "session.v4.jsonl.zstd");
    writeFileSync(file, Buffer.concat([frame([{ seq: 0, type: "a", data: 1 }]), frame([{ seq: 1, type: "b", data: 2 }])]));

    const first = dshReadTail(file, 0)!;
    expect(dshDecodeFrames(first.bytes).flatMap(dshEventsFromText).map((event) => event.seq)).toEqual([0, 1]);

    // 只追加两帧：从旧偏移读到的字节必须只包含新帧，且解出来正好是新增事件。
    appendFileSync(file, Buffer.concat([frame([{ seq: 2, type: "c", data: 3 }]), frame([{ seq: 3, type: "d", data: 4 }])]));
    const tail = dshReadTail(file, first.bytes.length)!;
    expect(tail.bytes.length).toBeLessThan(readFileSync(file).length);
    expect(dshDecodeFrames(tail.bytes).flatMap(dshEventsFromText).map((event) => event.seq)).toEqual([2, 3]);

    // 没有新增时不应返回任何字节（调用方据此复用缓存）。
    expect(dshReadTail(file, first.bytes.length + tail.bytes.length)).toBeUndefined();
  });

  it("skips half-written or corrupt lines instead of failing the whole read", () => {
    const text = `${JSON.stringify({ seq: 1, type: "a", data: 1 })}\n{"seq":2,"type":"b"`;
    expect(dshEventsFromText(text).map((event) => event.seq)).toEqual([1]);
  });
});
