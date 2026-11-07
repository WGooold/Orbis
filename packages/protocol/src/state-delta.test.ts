// FT-G06: object deletes and ordered array edits must reconstruct exact data;
// malformed paths fail before the caller commits the private reconstruction.
import { describe, it, expect } from "vitest";
import { stateDelta, applyStateDelta } from "./state-delta.js";

describe("FT-G06 state deltas", () => {
  it("round trips additions, explicit deletion, array insertion and exact unusual keys", () => {
    const before = JSON.parse('{"__proto__":{"value":1},"items":[{"id":"a","status":"running"},{"id":"b"}],"gone":true}');
    for (const after of [
      JSON.parse('{"__proto__":{"value":2},"items":[{"id":"a","status":"success"},{"id":"b"}],"new":null}'),
      { items: [{ id: "first" }, ...before.items, { id: "last" }] },
      { items: [before.items[1]] }, [], null,
    ]) expect(applyStateDelta(before, stateDelta(before, after)!)).toEqual(after);
    expect({}).not.toHaveProperty("value");
  });
  it("bounds edit counts and rejects invalid paths and array ranges", () => {
    expect(stateDelta({}, Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), i])))).toBeUndefined();
    expect(() => applyStateDelta({ items: [1] }, [{ op: "splice", path: ["items"], index: 2, deleteCount: 0, items: [] }])).toThrow();
    expect(() => applyStateDelta({}, [{ op: "remove", path: ["missing"] }])).toThrow();
    expect(() => applyStateDelta({ items: [1] }, [{ op: "set", path: ["items", "01"], value: 2 }])).toThrow();
  });
});
