// FT-G09: exact UTF-8 accounting, disjoint overhead, bounded sampling, no
// content/credential/dynamic-key disclosure and fixed owner-scoped pagination.
import { describe, it, expect } from "vitest";
import { TransportFieldsPageSchema } from "@orbis/protocol";
import { FieldTrafficMeter } from "./field-traffic-meter.js";

const label = { backend: "codex", messageType: "message.delta", reason: "producer" as const };
const request = (cursor: string | null = null) => ({ type: "transport.fields.read" as const, protocolVersion: 19 as const, requestId: "read", cursor, limit: 2 });
describe("FT-G09 field traffic metering", () => {
  it("measures inclusive and disjoint bytes without serializing or exposing values again", () => {
    let time = 1000; const meter = new FieldTrafficMeter(() => time);
    const payload = Buffer.from(JSON.stringify({ text: '中🙂\n"', options: [{ value: "one", label: null }, { value: "two", label: "Name" }],
      "private-dynamic-secret": { credential: "private-credential" } }));
    meter.record(payload, label); time += 2000; meter.record(payload, label);
    const rows = meter.snapshot(), text = rows.find(row => row.path === "$.text")!;
    expect(text.meanBytes).toBe(Buffer.byteLength(JSON.stringify('中🙂\n"')));
    expect(text).toMatchObject({ sampleCount: 2, nonNullCount: 2, messageCount: 2, repeatedCount: 1 });
    expect(rows.reduce((sum, row) => sum + row.ownSampleBytes, 0)).toBe(payload.length * 2);
    expect(rows.find(row => row.path === "$")!.totalSampleBytes).toBe(payload.length * 2);
    expect(rows.find(row => row.path === "$.options[].label")).toMatchObject({ sampleCount: 4, nonNullCount: 2 });
    const report = JSON.stringify(rows);
    for (const secret of ["private-dynamic-secret", "private-credential", "中🙂", "digest"]) expect(report).not.toContain(secret);
    expect(rows.some(row => row.path === "$.*.credential")).toBe(true);
  });
  it("counts every message while sampling high frequency traffic and bounding giant inputs", () => {
    const meter = new FieldTrafficMeter(() => 1000), payload = Buffer.from('{"text":"same"}');
    for (let i = 0; i < 64; i++) meter.record(payload, label);
    expect(meter.snapshot().find(row => row.path === "$")).toMatchObject({ messageCount: 64, messageBytes: payload.length * 64, sampleCount: 3 });
    meter.record(Buffer.alloc(2 * 1024 * 1024 + 1), { ...label, messageType: "giant" });
    expect(meter.page("a", request()).skippedSamples).toBeGreaterThan(0);
    expect(meter.snapshot().every(row => row.messageType !== "giant")).toBe(true);
  });
  it("freezes bounded pages and rejects other-device, replaced or expired cursors", () => {
    let time = 1000; const meter = new FieldTrafficMeter(() => time);
    for (let i = 0; i < 40; i++) meter.record(Buffer.from('{"text":"body","value":1}'), { ...label, messageType: `kind${i}` });
    const first = meter.page("a", request());
    expect(TransportFieldsPageSchema.safeParse(first).success).toBe(true);
    expect(first.rows).toHaveLength(2); expect(first.totalRows).toBe(120);
    const next = meter.page("a", request(first.nextCursor));
    expect(next.snapshotId).toBe(first.snapshotId); expect(next.offset).toBe(2);
    expect(next.sampledMessages).toBe(first.sampledMessages);
    expect(meter.page("b", request(first.nextCursor)).error).toBe("invalid_cursor");
    meter.page("a", request()); expect(meter.page("a", request(first.nextCursor)).error).toBe("invalid_cursor");
    const fresh = meter.page("a", request()); time += 60_001;
    expect(meter.page("a", request(fresh.nextCursor)).error).toBe("invalid_cursor");
    expect(Buffer.byteLength(JSON.stringify(fresh))).toBeLessThan(64 * 1024);
    const held = meter.page("owner-0", request());
    for (let i = 1; i <= 8; i++) meter.page(`owner-${i}`, request());
    expect(meter.page("owner-0", request(held.nextCursor)).error).toBe("invalid_cursor");
  });
});
