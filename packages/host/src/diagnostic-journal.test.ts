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
});
