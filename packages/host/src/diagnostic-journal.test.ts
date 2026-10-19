import type { DiagnosticRecord } from "@pi-remote/protocol";
import { describe, expect, it } from "vitest";

import { DiagnosticJournal } from "./diagnostic-journal.js";

const record = (over: Partial<Parameters<DiagnosticJournal["append"]>[0]> = {}) => ({
  scope: "agent" as const,
  agentKind: "pi" as const,
  sessionId: "s1",
  category: "execution",
  severity: "info" as const,
  message: "turn finished",
  ...over,
});

describe("DiagnosticJournal", () => {
  it("reports a cursor from a prior process as a gap without skipping the restored window", () => {
    const memory = memoryPersistence();
    const first = new DiagnosticJournal({ persistence: memory });
    first.append(record({ message: "a" })); first.append(record({ message: "b" }));
    const cursor = first.page({ limit: 1 }).nextCursor;
    const next = new DiagnosticJournal({ persistence: memory });
    expect(next.page({ cursor })).toMatchObject({ truncated: true, nextCursor: null });
    expect(next.page({ cursor }).records.map(item => item.message)).toEqual(["a", "b"]);
    expect(next.page().records[0]?.producerEpoch).toBe(first.page().records[0]?.producerEpoch);
  });

  it("bounds storage and pages by bytes and redacts common credential strings", () => {
    const journal = new DiagnosticJournal({ maxBytes: 32_768, maxPageBytes: 16_384 });
    for (let n = 0; n < 30; n += 1) journal.append(record({
      message: "failure sk-private-value token=secret-value", detail: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(i), "x".repeat(256)])),
    }));
    const first = journal.page();
    expect(first.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(17_000);
    expect(journal.stats().dropped).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toContain("private-value");
    expect(JSON.stringify(first)).not.toContain("secret-value");
  });

  it("filters same-named sessions by backend and returns null for an empty window", () => {
    const journal = new DiagnosticJournal();
    expect(journal.page().nextCursor).toBeNull();
    journal.append(record()); journal.append(record({ agentKind: "dsh" }));
    expect(journal.page({ sessionId: "s1", agentKind: "dsh" }).records).toHaveLength(1);
  });
  it("按游标分页读完整个保留窗口，最后给 null", () => {
    const journal = new DiagnosticJournal();
    for (let index = 0; index < 5; index += 1) journal.append(record({ message: `m${index}` }));

    const first = journal.page({ limit: 2 });
    expect(first.records.map(r => r.message)).toEqual(["m0", "m1"]);
    const second = journal.page({ cursor: first.nextCursor, limit: 2 });
    expect(second.records.map(r => r.message)).toEqual(["m2", "m3"]);
    const third = journal.page({ cursor: second.nextCursor, limit: 2 });
    expect(third.records.map(r => r.message)).toEqual(["m4"]);
    expect(third.nextCursor).toBeNull();
  });


  it("游标朝更新的方向翻页：nextCursor 不为 null 表示更新的还没读", () => {
    const journal = new DiagnosticJournal();
    for (let index = 0; index < 3; index += 1) journal.append(record({ message: `m${index}` }));

    const first = journal.page({ limit: 2 });
    expect(first.records.map(r => r.message)).toEqual(["m0", "m1"]);
    // m2 比这一页更新：游标说的是「更新的还没读」，不是「还有更早的」。
    expect(first.nextCursor).not.toBeNull();
    const second = journal.page({ cursor: first.nextCursor, limit: 2 });
    expect(second.records.map(r => r.message)).toEqual(["m2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("被过滤掉的记录也要越过，下一页不能原地打转", () => {
    const journal = new DiagnosticJournal();
    journal.append(record({ message: "info", severity: "info" }));
    journal.append(record({ message: "boom", severity: "error" }));
    journal.append(record({ message: "info2", severity: "info" }));

    const page = journal.page({ limit: 1, severity: "error" });
    expect(page.records.map(r => r.message)).toEqual(["boom"]);
    const rest = journal.page({ cursor: page.nextCursor, severity: "error" });
    expect(rest.records).toEqual([]);
    expect(rest.nextCursor).toBeNull();
  });

  it("游标指向已淘汰的位置时报告缺口，而不是假装从头开始", () => {
    const journal = new DiagnosticJournal({ maxRecords: 2 });
    journal.append(record({ message: "old1" }));
    journal.append(record({ message: "old2" }));
    // 游标停在第一条：之后中间的记录会被淘汰掉。
    const cursor = journal.page({ limit: 1 }).nextCursor;
    expect(cursor).not.toBeNull();
    journal.append(record({ message: "a" }));
    journal.append(record({ message: "b" }));
    journal.append(record({ message: "c" }));

    const page = journal.page({ cursor });
    expect(page.truncated).toBe(true);
    expect(page.records.map(r => r.message)).toEqual(["b", "c"]);
    expect(journal.stats().dropped).toBeGreaterThan(0);
  });

  it("保留窗口到期即淘汰，并计入 dropped", () => {
    let now = 1_000;
    const journal = new DiagnosticJournal({ retentionMs: 100, now: () => now });
    journal.append(record({ message: "old" }));
    now = 2_000;
    journal.append(record({ message: "new" }));

    expect(journal.page().records.map(r => r.message)).toEqual(["new"]);
    expect(journal.stats()).toMatchObject({ records: 1, dropped: 1 });
  });

  it("按会话清掉记录：留着的只会变成误导", () => {
    const journal = new DiagnosticJournal();
    journal.append(record({ sessionId: "s1", message: "a" }));
    journal.append(record({ sessionId: "s2", message: "b" }));

    expect(journal.forgetSession("s1")).toBe(1);
    expect(journal.page().records.map(r => r.message)).toEqual(["b"]);
  });

  it("重启后读回上一次运行留下的记录", () => {
    const memory = memoryPersistence();
    const before = new DiagnosticJournal({ persistence: memory, now: () => 1_000 });
    before.append(record({ message: "上一轮为什么连不上" }));

    const after = new DiagnosticJournal({ persistence: memory, now: () => 2_000 });
    expect(after.page().records.map(r => r.message)).toEqual(["上一轮为什么连不上"]);
  });

  it("淘汰后整体重写：盘上那份不能比内存更旧、更长", () => {
    const memory = memoryPersistence();
    const journal = new DiagnosticJournal({ persistence: memory, maxRecords: 2, now: () => 1_000 });
    journal.append(record({ message: "a" }));
    journal.append(record({ message: "b" }));
    journal.append(record({ message: "c" }));

    expect(memory.records.map(r => r.message)).toEqual(["b", "c"]);
    expect(journal.stats()).toMatchObject({ records: 2, dropped: 1, persistFailures: 0 });
  });

  it("按会话清掉时也要重写盘上那份", () => {
    const memory = memoryPersistence();
    const journal = new DiagnosticJournal({ persistence: memory, now: () => 1_000 });
    journal.append(record({ sessionId: "s1", message: "a" }));
    journal.append(record({ sessionId: "s2", message: "b" }));

    expect(journal.forgetSession("s1")).toBe(1);
    expect(memory.records.map(r => r.message)).toEqual(["b"]);
  });

  it("落盘失败只记缺口：记录本身照旧返回，也没有记录写丢", () => {
    const journal = new DiagnosticJournal({
      now: () => 1_000,
      persistence: {
        load: () => [],
        append: () => { throw new Error("disk full"); },
        rewrite: () => { throw new Error("disk full"); },
      },
    });

    expect(journal.append(record({ message: "still recorded" })).message).toBe("still recorded");
    expect(journal.page().records.map(r => r.message)).toEqual(["still recorded"]);
    expect(journal.stats().persistFailures).toBe(1);
  });

  it("读盘失败不让 Journal 构造失败：Host 不能因为诊断起不来", () => {
    const journal = new DiagnosticJournal({
      persistence: {
        load: () => { throw new Error("unreadable"); },
        append: () => {},
        rewrite: () => {},
      },
    });

    expect(journal.page().records).toEqual([]);
    expect(journal.stats().persistFailures).toBe(1);
  });
});

/** 内存版持久化：只验证「什么时候写」，不碰真实文件（真实文件见 file-store 的测试）。 */
function memoryPersistence() {
  const records: DiagnosticRecord[] = [];
  return {
    records,
    load: () => [...records],
    append: (item: DiagnosticRecord) => { records.push(item); },
    rewrite: (next: readonly DiagnosticRecord[]) => { records.splice(0, records.length, ...next); },
  };
}
