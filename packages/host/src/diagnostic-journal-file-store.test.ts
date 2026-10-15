import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticJournal } from "./diagnostic-journal.js";
import { DIAGNOSTIC_JOURNAL_FILE, createDiagnosticJournalFileStore } from "./diagnostic-journal-file-store.js";

let dir = "";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "orbis-diagnostics-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const record = (over: Partial<Parameters<DiagnosticJournal["append"]>[0]> = {}) => ({
  scope: "host" as const,
  agentKind: null,
  sessionId: null,
  category: "transport",
  severity: "warning" as const,
  message: "relay unreachable",
  ...over,
});

describe("createDiagnosticJournalFileStore", () => {
  it("还没有文件时读回空清单，而不是报错", () => {
    expect(createDiagnosticJournalFileStore(dir).load()).toEqual([]);
  });

  it("追加的记录按写入顺序读回，字段原样保留", () => {
    const store = createDiagnosticJournalFileStore(dir);
    const journal = new DiagnosticJournal({ persistence: store, now: () => 1_000 });
    journal.append(record({ message: "first" }));
    journal.append(record({ message: "second", detail: { code: "ECONNREFUSED" } }));

    const reloaded = createDiagnosticJournalFileStore(dir).load();
    expect(reloaded.map(r => r.message)).toEqual(["first", "second"]);
    expect(reloaded[1]?.detail).toEqual({ code: "ECONNREFUSED" });
  });

  it("重写替换盘上那份，不会留下旧尾巴", () => {
    const store = createDiagnosticJournalFileStore(dir);
    store.append(record({ recordId: "a", at: 1, message: "old" }) as never);
    store.append(record({ recordId: "b", at: 2, message: "older" }) as never);

    store.rewrite([{ recordId: "b", scope: "host", agentKind: null, sessionId: null, category: "transport", severity: "warning", message: "kept", at: 2 }]);
    expect(store.load().map(r => r.message)).toEqual(["kept"]);
  });

  it("末尾残句与坏行只丢那一行，其余记录照旧可用", () => {
    const store = createDiagnosticJournalFileStore(dir);
    store.append(record({ recordId: "a", at: 1, message: "good" }) as never);
    const path = join(dir, DIAGNOSTIC_JOURNAL_FILE);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"recordId":"torn",` + "\n" + 'not json\n');

    expect(store.load().map(r => r.message)).toEqual(["good"]);
  });
});
