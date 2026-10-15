import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DiagnosticRecordSchema, type DiagnosticRecord } from "@pi-remote/protocol";

import type { DiagnosticJournalPersistence } from "./diagnostic-journal.js";

/**
 * 诊断记录的落盘实现（ADR-0032 模块 23）。
 *
 * 形状是**一行一条 JSON**：追加便宜，而且写到一半被杀进程只会留下一行残句，不会毁掉整份文件。
 * 三个纪律：
 * - 读盘时**一行坏了只丢那一行**：其余记录照旧可用，不能因为末尾残句把整段历史判死；
 * - 重写走「临时文件 + 原子替换」，读的人要么看到旧的完整版，要么看到新的完整版；
 * - 这里只做文件读写，淘汰与有界由 `DiagnosticJournal` 决定（写什么必须由它说了算）。
 */

export const DIAGNOSTIC_JOURNAL_FILE = "diagnostics.ndjson";

export function createDiagnosticJournalFileStore(stateDir: string): DiagnosticJournalPersistence {
  const path = join(stateDir, DIAGNOSTIC_JOURNAL_FILE);
  return {
    load: () => readRecords(path),
    append: (record) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    },
    rewrite: (records) => {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, records.map(record => `${JSON.stringify(record)}\n`).join(""), "utf8");
      try {
        renameSync(temporary, path);
      } catch (error) {
        // 替换失败不能留下临时文件：下次重写会再建一个，攒着只会让状态目录越来越难解释。
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}

/** 读回记录：坏行跳过，顺序按文件里的先后（也就是写入顺序）。 */
export function readRecords(path: string): DiagnosticRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // 还没有这份文件是正常状态，不是错误。
    return [];
  }
  const records: DiagnosticRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const result = DiagnosticRecordSchema.safeParse(parsed);
    if (result.success) records.push(result.data);
  }
  return records;
}
