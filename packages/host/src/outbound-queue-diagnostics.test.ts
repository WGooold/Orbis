import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OutboundQueueDiagnostic } from "@orbis/protocol";
import { DiagnosticJournal } from "./diagnostic-journal.js";
import { createDiagnosticJournalFileStore } from "./diagnostic-journal-file-store.js";
import { outboundQueueDiagnosticRecords, outboundQueueSource } from "./outbound-queue-diagnostics.js";

describe("outbound queue diagnostics", () => {
  it("attributes runtime patches and model domains without retaining message contents", () => {
    const patch = outboundQueueSource({ type: "runtime.event", runtimeId: "runtime-a", token: "private-token",
      event: { type: "session.patch", sessionId: "session-a", live: { text: "private-chat" } } }, 800);
    expect(patch).toEqual({ type: "runtime.event", eventType: "session.patch", runtimeId: "runtime-a", sessionId: "session-a", payloadBytes: 800 });
    expect(outboundQueueSource({ type: "agent.state.snapshot", runtimeId: "runtime-b", sessionId: "session-b",
      domains: [{ domain: "records", value: "private-record" }, { domain: "execution", value: "private-state" }] }, 1_200))
      .toEqual({ type: "agent.state.snapshot", runtimeId: "runtime-b", sessionId: "session-b", domains: "execution,records", payloadBytes: 1_200 });
    expect(JSON.stringify(patch)).not.toContain("private-");
  });

  it("persists correlated summary and per-source fields without journal truncation or content leakage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbis-queue-diagnostics-"));
    try {
      const journal = new DiagnosticJournal({ now: () => 10_000, persistence: createDiagnosticJournalFileStore(dir) });
      const sample: OutboundQueueDiagnostic = {
        queuedBytes: 219_133_492, nonBulkQueuedBytes: 219_133_492, bulkQueuedBytes: 0,
        transportBacklogBytes: 70_000, oldestQueuedMs: 8_000, windowMs: 5_000,
        nonBulkEnqueuedBytes: 180_000_000, nonBulkWrittenBytes: 16_000_000, writeErrors: 0,
        sources: [{ channel: "msg", ...outboundQueueSource({ type: "runtime.event", runtimeId: "runtime-a",
          event: { type: "session.patch", sessionId: "session-a", text: "private-chat" } }, 400_000),
          queuedBytes: 200_000_000, queuedPieces: 25_000, oldestQueuedMs: 8_000, maxPayloadBytes: 400_000 }],
        otherSourceBytes: 19_133_492, sourcesTruncated: true,
      };
      const inputs = outboundQueueDiagnosticRecords("device-a", "lan", sample, 10_000);
      expect(inputs).toHaveLength(2);
      for (const input of inputs) journal.append({ ...input, hostId: "host-a" });
      const raw = await readFile(join(dir, "diagnostics.ndjson"), "utf8");
      const persisted = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(persisted[0]).toMatchObject({ category: "transport.queue", message: "outbound_queue_pressure", detail: {
        nonBulkQueuedBytes: "219133492", windowMs: "5000",
        nonBulkEnqueuedBytes: "180000000", nonBulkWrittenBytes: "16000000", sourcesTruncated: "true",
      } });
      expect(persisted[1]).toMatchObject({ sessionId: "session-a", operationId: persisted[0].operationId,
        message: "outbound_queue_source", detail: { type: "runtime.event", eventType: "session.patch", runtimeId: "runtime-a", queuedBytes: "200000000" } });
      inputs.forEach((input, index) => expect(persisted[index].detail).toEqual(input.detail));
      expect(raw).not.toContain("private-chat");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
