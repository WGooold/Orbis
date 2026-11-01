import { describe, expect, it } from "vitest";
import { RuntimeCommandSchema, RuntimeEventSchema, RuntimeCommandStatusSchema,
  runtimeInputOwners, messageInputDecision, canDispatchMessage, inputMutationError, type RuntimeInputState } from "./index.js";

describe("all runtime inputs and states (AIN-01/02)", () => {
  it("registers exactly every wire input, including service requests and one-way ACKs", () => {
    const types = RuntimeCommandSchema.options.map(option => option.shape.type.value);
    expect(Object.keys(runtimeInputOwners).sort()).toEqual(types.sort());
    expect(types).toHaveLength(20);
    expect(RuntimeCommandSchema.safeParse({ type: "future.input" }).success).toBe(false);
    expect(RuntimeCommandStatusSchema.parse("unconfirmed")).toBe("unconfirmed");
    expect(RuntimeEventSchema.safeParse({ type: "message.queued", queueId: "q", text: "hi", delivery: "followUp", state: "unconfirmed" }).success).toBe(true);
  });

  const cases: { name: string; state: RuntimeInputState; plain: string; delivery: string; write: string | undefined }[] = [
    { name: "idle", state: { phase: "idle" }, plain: "start", delivery: "start", write: undefined },
    { name: "starting", state: { phase: "idle", starting: true }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "running", state: { phase: "running" }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "waiting", state: { phase: "waiting_local_interaction" }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "standalone compaction", state: { phase: "idle", compacting: true }, plain: "queue", delivery: "queue", write: "runtime_busy" },
    { name: "auto compaction", state: { phase: "running", compacting: true }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "retry", state: { phase: "running" }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "stopping", state: { phase: "idle", stopping: true }, plain: "reject", delivery: "queue", write: "runtime_busy" },
    { name: "recovering", state: { phase: "idle", reconciling: true }, plain: "reject", delivery: "reject", write: "state_unavailable" },
    { name: "config/provider/replacement", state: { phase: "idle", mutating: true }, plain: "reject", delivery: "reject", write: "runtime_busy" },
    { name: "closing", state: { phase: "idle", closing: true }, plain: "reject", delivery: "reject", write: "runtime_closing" },
    { name: "offline/closed/archived", state: { phase: "idle", offline: true }, plain: "reject", delivery: "reject", write: "runtime_offline" },
    { name: "disconnected/reconnecting", state: { phase: "unknown", offline: true }, plain: "reject", delivery: "reject", write: "runtime_offline" },
    { name: "unknown", state: { phase: "unknown" }, plain: "reject", delivery: "reject", write: "state_unavailable" },
  ];
  it.each(cases)("covers $name with all delivery modes, mutation/query/control and dispatch", ({ state, plain, delivery, write }) => {
    expect(messageInputDecision(state).action).toBe(plain);
    for (const mode of ["followUp", "steer"] as const) expect(messageInputDecision(state, mode).action).toBe(delivery);
    expect(inputMutationError(state)).toBe(write);
    expect(inputMutationError(state, "read")).toBe(state.offline ? "runtime_offline" : state.closing ? "runtime_closing" : undefined);
    expect(inputMutationError(state, "close")).toBe(state.offline ? "runtime_offline" : state.closing ? "runtime_closing" : undefined);
    expect(canDispatchMessage(state)).toBe(plain === "start");
  });

  it("applies precedence to overlapping native facts and does not let later inputs bypass a queue", () => {
    for (const phase of ["idle", "running", "waiting_local_interaction", "unknown"] as const) {
      for (const compacting of [false, true]) for (const starting of [false, true]) for (const reconciling of [false, true]) {
        const state = { phase, compacting, starting, reconciling };
        expect(messageInputDecision({ ...state, closing: true })).toEqual({ action: "reject", error: "runtime_closing" });
        expect(messageInputDecision({ ...state, offline: true, closing: true })).toEqual({ action: "reject", error: "runtime_offline" });
        if (compacting || starting || reconciling || phase !== "idle") expect(canDispatchMessage(state)).toBe(false);
      }
    }
    expect(messageInputDecision({ phase: "idle", queueDepth: 1 })).toEqual({ action: "reject", error: "runtime_busy" });
    expect(messageInputDecision({ phase: "idle", compacting: true })).toEqual({ action: "queue", delivery: "followUp" });
  });
});
