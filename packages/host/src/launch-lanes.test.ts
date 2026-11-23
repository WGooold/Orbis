import { describe, expect, it } from "vitest";

import { KeyedLanes, ProviderLaunchGate, providerGroup } from "./launch-lanes.js";

const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("KeyedLanes", () => {
  // LAUNCH-QUEUE-01: the old single Host chain let one pending start hold every
  // other key, and one rejection skipped every later task.
  it("orders tasks per key, runs disjoint keys concurrently and survives a rejection", async () => {
    const lanes = new KeyedLanes();
    const order: string[] = [];
    const stuck = deferred();
    const first = lanes.run(["a"], async () => { order.push("a1"); await stuck.promise; order.push("a1 done"); });
    const second = lanes.run(["a"], async () => { order.push("a2"); });
    const other = lanes.run(["b"], async () => { order.push("b"); });
    await other;
    expect(order).toEqual(["a1", "b"]);
    stuck.reject(new Error("native start failed"));
    await expect(first).rejects.toThrow("native start failed");
    await second;
    expect(order).toEqual(["a1", "b", "a2"]);
  });

  // A task naming several keys waits for each earlier holder; later tasks on any of them wait for it.
  it("waits for every key a task names", async () => {
    const lanes = new KeyedLanes();
    const order: string[] = [];
    const a = deferred(), b = deferred();
    void lanes.run(["a"], async () => { await a.promise; order.push("a"); });
    void lanes.run(["b"], async () => { await b.promise; order.push("b"); });
    const both = lanes.run(["a", "b"], async () => { order.push("both"); });
    const after = lanes.run(["b"], async () => { order.push("after"); });
    a.resolve(); await tick();
    expect(order).toEqual(["a"]);
    b.resolve(); await both; await after;
    expect(order).toEqual(["a", "b", "both", "after"]);
  });
});

describe("ProviderLaunchGate", () => {
  // A provider change must not rewrite settings a running launch reads, nor wait behind a stuck one.
  it("holds new launches during a change and reports running launches without waiting", async () => {
    const gate = new ProviderLaunchGate();
    const release = await gate.enter(providerGroup("codexDesktop"));
    expect(gate.busy("codex")).toBe(true);
    expect(gate.busy("claude")).toBe(false);
    release(); release();
    expect(gate.busy("codex")).toBe(false);

    const change = deferred();
    const exclusive = gate.exclusive("codex", () => change.promise);
    let entered = false, unrelated = false;
    const waiting = gate.enter("codex").then(done => { entered = true; return done; });
    void gate.enter("claude").then(() => { unrelated = true; });
    await tick();
    expect([entered, unrelated]).toEqual([false, true]);
    change.resolve(); await exclusive;
    (await waiting)();
    expect(entered).toBe(true);
  });

  // A legacy resume without a known agent conflicts with every group.
  it("treats an unresolved agent as every group", async () => {
    const gate = new ProviderLaunchGate();
    const release = await gate.enter(undefined);
    expect(gate.busy("dsh")).toBe(true);
    release();
    const change = deferred();
    const exclusive = gate.exclusive("pi", () => change.promise);
    let entered = false;
    const waiting = gate.enter(undefined).then(done => { entered = true; return done; });
    await tick();
    expect(entered).toBe(false);
    change.resolve(); await exclusive; (await waiting)();
    expect(entered).toBe(true);
  });
});
