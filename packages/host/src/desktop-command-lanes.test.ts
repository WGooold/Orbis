import { describe, expect, it } from "vitest";
import { DesktopCommandLanes, desktopCommandLane } from "./desktop-command-lanes.js";

/** A task that records when it starts and finishes only when the test releases it. */
function gate(log: string[], name: string): { task: () => Promise<void>; release: () => void; started: () => boolean } {
  let release!: () => void;
  let started = false;
  const done = new Promise<void>(resolve => { release = resolve; });
  return {
    task: async () => { started = true; log.push(`start:${name}`); await done; log.push(`end:${name}`); },
    release: () => release(),
    started: () => started,
  };
}
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

// HOST-LANE-01 (ADR-0081 §5-2): the bridge used to run every command in one queue, so a 25 s Agent
// detection held Connect, Pause and Add phone. These cases pin which commands may now pass which.
describe("desktop command lanes", () => {
  it("classifies only read-only probes as background and connection commands as lifecycle", () => {
    expect(["detect", "state.read", "state.range", "provider.check", "provider.models"].map(desktopCommandLane)).toEqual(Array(5).fill("background"));
    expect(["start", "pair", "cancelPair"].map(desktopCommandLane)).toEqual(Array(3).fill("lifecycle"));
    expect(["stop", "shutdown"].map(desktopCommandLane)).toEqual(["preempt", "preempt"]);
    for (const method of ["initialize", "updateAgent", "installAll", "provider.save", "rename", "revoke", "restartDshServer", "unknown"]) {
      expect(desktopCommandLane(method)).toBe("exclusive");
    }
  });

  it("starts the Host while a slow Agent detection is still running", async () => {
    const lanes = new DesktopCommandLanes(); const log: string[] = [];
    const detect = gate(log, "detect"); const start = gate(log, "start");
    void lanes.enqueue("detect", detect.task);
    void lanes.enqueue("start", start.task);
    await settle();
    expect(start.started()).toBe(true);
    detect.release(); start.release(); await lanes.drain();
  });

  it("pauses without waiting for an in-flight start, and the next start waits for the pause", async () => {
    const lanes = new DesktopCommandLanes(); const log: string[] = [];
    const first = gate(log, "start1"); const stop = gate(log, "stop"); const second = gate(log, "start2");
    void lanes.enqueue("start", first.task);
    void lanes.enqueue("stop", stop.task);
    void lanes.enqueue("start", second.task);
    await settle();
    expect(stop.started()).toBe(true);
    stop.release(); await settle();
    expect(second.started()).toBe(false);
    first.release(); await settle();
    expect(second.started()).toBe(true);
    second.release(); await lanes.drain();
  });

  // HOST-LIVE-01 relies on stop → change → start ordering; an exclusive change must not interleave.
  it("keeps exclusive changes ordered against both lanes", async () => {
    const lanes = new DesktopCommandLanes(); const log: string[] = [];
    const detect = gate(log, "detect"); const stop = gate(log, "stop"); const install = gate(log, "install"); const start = gate(log, "start");
    const later = gate(log, "laterDetect");
    void lanes.enqueue("detect", detect.task);
    void lanes.enqueue("stop", stop.task);
    void lanes.enqueue("updateAgent", install.task);
    void lanes.enqueue("start", start.task);
    void lanes.enqueue("detect", later.task);
    await settle();
    expect(install.started()).toBe(false);
    stop.release(); await settle();
    expect(install.started()).toBe(false);
    detect.release(); await settle();
    expect(install.started()).toBe(true);
    expect(start.started()).toBe(false);
    expect(later.started()).toBe(false);
    install.release(); await settle();
    expect(start.started()).toBe(true);
    expect(later.started()).toBe(true);
    start.release(); later.release(); await lanes.drain();
  });

  it("waits for exclusive work before pausing, and for background writes before shutting down", async () => {
    const lanes = new DesktopCommandLanes(); const log: string[] = [];
    const save = gate(log, "save"); const stop = gate(log, "stop");
    void lanes.enqueue("provider.save", save.task);
    void lanes.enqueue("stop", stop.task);
    await settle();
    expect(stop.started()).toBe(false);
    save.release(); await settle();
    expect(stop.started()).toBe(true);
    stop.release(); await lanes.drain();

    const detect = gate(log, "detect"); const start = gate(log, "start"); const shutdown = gate(log, "shutdown");
    void lanes.enqueue("detect", detect.task);
    void lanes.enqueue("start", start.task);
    void lanes.enqueue("shutdown", shutdown.task);
    await settle();
    expect(shutdown.started()).toBe(false);
    detect.release(); await settle();
    expect(shutdown.started()).toBe(true);
    start.release(); shutdown.release(); await lanes.drain();
  });

  it("keeps running later commands after one fails", async () => {
    const lanes = new DesktopCommandLanes(); const log: string[] = [];
    void lanes.enqueue("rename", async () => { throw new Error("rejected"); });
    await lanes.enqueue("detect", async () => { log.push("detect"); });
    expect(log).toEqual(["detect"]);
  });
});
