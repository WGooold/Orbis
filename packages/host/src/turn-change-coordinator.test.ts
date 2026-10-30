import { describe, expect, it, vi } from "vitest";
import { TurnChangeCoordinator } from "./turn-change-coordinator.js";
import type { TurnFileChangeService } from "./turn-file-change-service.js";

function fixture(barrierMs = 2_000) {
  const service = { begin: vi.fn(async () => {}), finish: vi.fn(async () => {}), observeTurn: vi.fn(),
    markUnreliable: vi.fn(), releaseRuntime: vi.fn() };
  const owner = new TurnChangeCoordinator(service as unknown as TurnFileChangeService,
    () => ({ hostId: "h", agentKind: "pi", sessionId: "s" }),
    () => ({ runtimeId: "r", cwd: "/workspace", sessionId: "s", name: "Pi", status: "running" }), barrierMs);
  return { service, owner };
}
describe("turn capture execution boundaries", () => {
  it("releases a stalled baseline at the barrier deadline and marks it partial", async () => {
    const { service, owner } = fixture(10);
    let complete!: () => void;
    service.begin.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await owner.begin("r", "slow");
    expect(service.markUnreliable).toHaveBeenCalledWith("r", "capture-barrier-released", "slow");
    complete(); await owner.close();
  });
  it("marks a timed-out HTTP start partial even if its baseline later finishes", async () => {
    const { service, owner } = fixture();
    let complete!: () => void;
    service.begin.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const starting = owner.begin("r", "disconnected", true, true, true, controller.signal);
    await vi.waitFor(() => expect(service.begin).toHaveBeenCalledOnce());
    controller.abort(); await starting;
    expect(service.markUnreliable).toHaveBeenCalledWith("r", "capture-barrier-disconnected", "disconnected");
    complete(); await owner.close();
  });
  it("marks an uncoordinated native start during a baseline partial", async () => {
    const { service, owner } = fixture();
    let complete!: () => void;
    service.begin.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const starting = owner.begin("r", "capturing");
    await vi.waitFor(() => expect(service.begin).toHaveBeenCalledOnce());
    const native = owner.started("r", "native");
    await starting;
    expect(service.markUnreliable).toHaveBeenCalledWith("r", "capture-barrier-released", "capturing");
    complete(); await native; await owner.close();
  });
  it("awaits the prior terminal snapshot before permitting the queued turn baseline", async () => {
    const { service, owner } = fixture();
    await owner.begin("r", "first"); await owner.started("r", "native-1");
    let end!: () => void;
    service.finish.mockImplementationOnce(() => new Promise(resolve => { end = resolve; }));
    const finishing = owner.finish("r", { turnId: "native-1", anchorEntryId: "answer-1" });
    const beginning = owner.begin("r", "second");
    await vi.waitFor(() => expect(service.finish).toHaveBeenCalledOnce());
    expect(service.begin).toHaveBeenCalledOnce();
    end(); await finishing; await beginning;
    expect(service.begin).toHaveBeenLastCalledWith(expect.objectContaining({ reviewTurnId: "second", reliable: true }));
  });
  it("combines internal Pi turns until its native top-level settled barrier", async () => {
    const { service, owner } = fixture();
    await owner.begin("r", "top", true); await owner.started("r", "step-1");
    await owner.finish("r", { turnId: "step-1" });
    await owner.started("r", "step-2");
    expect(service.finish).not.toHaveBeenCalled();
    await owner.finish("r", { turnId: "top", force: true, anchorEntryId: "persisted-answer", outcome: "cancelled" });
    expect(service.finish).toHaveBeenCalledWith("r", expect.objectContaining({ reviewTurnId: "top", anchorEntryId: "persisted-answer", outcome: "cancelled" }));
  });
  it("marks observed-only starts partial and refuses a stale completion", async () => {
    const { service, owner } = fixture();
    await owner.started("r", "external");
    expect(service.begin).toHaveBeenCalledWith(expect.objectContaining({ reliable: false, reviewTurnId: "external" }));
    await owner.finish("r", { turnId: "older" });
    expect(service.finish).not.toHaveBeenCalled();
    await owner.finish("r", { turnId: "external" });
    expect(service.finish).toHaveBeenCalledOnce();
  });
  it("downgrades an end capture when an uncoordinated next turn starts while it is scanning", async () => {
    const { service, owner } = fixture();
    await owner.begin("r", "first"); await owner.started("r", "native-1");
    let end!: () => void;
    service.finish.mockImplementationOnce(() => new Promise(resolve => { end = resolve; }));
    const finishing = owner.finish("r", { turnId: "native-1" });
    await vi.waitFor(() => expect(service.finish).toHaveBeenCalledOnce());
    const external = owner.started("r", "native-2");
    expect(service.markUnreliable).toHaveBeenCalledWith("r", "next-turn-started-during-capture");
    end(); await finishing; await external;
  });
});
