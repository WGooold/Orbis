import type { StateDeltaOperation } from "./agent-state.js";

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** FT-G06: bounded edits against one exact committed value. No implicit deletion. */
export function stateDelta(before: unknown, after: unknown): StateDeltaOperation[] | undefined {
  const operations: StateDeltaOperation[] = [];
  function visit(a: unknown, b: unknown, path: string[]): void {
    if (equal(a, b)) return;
    if (operations.length > 256 || path.length > 32) throw new Error("delta_budget");
    if (object(a) && object(b)) {
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) operations.push({ op: "remove", path: [...path, key] });
      for (const [key, value] of Object.entries(b)) {
        if (Object.hasOwn(a, key)) visit(a[key], value, [...path, key]);
        else operations.push({ op: "set", path: [...path, key], value });
      }
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length === b.length) a.forEach((value, index) => visit(value, b[index], [...path, String(index)]));
      else {
        let start = 0, end = 0;
        while (start < Math.min(a.length, b.length) && equal(a[start], b[start])) start++;
        while (end < Math.min(a.length, b.length) - start && equal(a[a.length - 1 - end], b[b.length - 1 - end])) end++;
        operations.push({ op: "splice", path, index: start, deleteCount: a.length - start - end, items: b.slice(start, b.length - end) });
      }
    } else if (typeof a === "string" && typeof b === "string" && a.length >= 128 && b.startsWith(a)) operations.push({ op: "append", path, text: b.slice(a.length) });
    else operations.push({ op: "set", path, value: b });
  }
  try { visit(before, after, []); } catch { return undefined; }
  return operations.length > 0 && operations.length <= 256 && operations.every(edit => edit.path.length <= 32) ? operations : undefined;
}

/** Reference decoder used by contract tests; mobile decoders implement the same strict edits. */
export function applyStateDelta(value: unknown, operations: readonly StateDeltaOperation[]): unknown {
  let result: unknown = structuredClone(value);
  for (const edit of operations) {
    let target: unknown = result;
    for (const key of edit.path.slice(0, edit.op === "splice" || edit.op === "append" ? undefined : -1)) {
      if (Array.isArray(target)) { if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length) throw Error("path"); target = target[Number(key)]; }
      else if (object(target) && Object.hasOwn(target, key)) target = target[key];
      else throw Error("path");
    }
    if (edit.op === "append") {
      if (typeof target !== "string") throw Error("append");
      result = applyStateDelta(result, [{ op: "set", path: edit.path, value: target + edit.text }]);
    } else if (edit.op === "splice") {
      if (!Array.isArray(target) || edit.index > target.length || edit.index + edit.deleteCount > target.length) throw Error("splice");
      target.splice(edit.index, edit.deleteCount, ...structuredClone(edit.items));
    } else if (edit.path.length === 0) {
      if (edit.op !== "set") throw Error("root"); result = structuredClone(edit.value);
    } else {
      const key = edit.path.at(-1)!;
      if (Array.isArray(target)) {
        if (edit.op !== "set" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length) throw Error("index");
        target[Number(key)] = structuredClone(edit.value);
      } else if (object(target)) {
        if (edit.op === "remove") { if (!Object.hasOwn(target, key)) throw Error("remove"); delete target[key]; }
        else Object.defineProperty(target, key, { value: structuredClone(edit.value), enumerable: true, writable: true, configurable: true });
      } else throw Error("target");
    }
  }
  return result;
}
