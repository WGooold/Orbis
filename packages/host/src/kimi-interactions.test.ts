import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import { KimiInteractions } from "./kimi-interactions.js";
import { KimiBusinessError } from "./kimi-web-client.js";

const nativeId = "session_fixture";
const runtimeId = "kimi-code:root:session_fixture";
const future = "2099-01-01T00:00:00.000Z";
const approval = { type: "interaction", session_id: nativeId, agent_id: "main", interaction_id: "approval/one", status: "pending", kind: "approval",
  request: { tool_name: "Shell", action: "Run a test", expires_at: future, tool_input_display: { kind: "command", cwd: "/fixture", command: "printf fixture" } } };
const question = { ...approval, interaction_id: "question-one", kind: "question", request: { questions: [
  { id: "q1", question: "Choose one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
  { id: "q2", question: "Choose several", body: "Context", multi_select: true, allow_other: true,
    options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }] },
] } };
function harness(verifyLocal: () => Promise<void> = async () => {}) {
  const events: RuntimeEvent[] = [];
  const request = vi.fn<(path: string, init?: {method?: string; body?: unknown}) => Promise<unknown>>();
  const resubscribe = vi.fn();
  const track = new KimiInteractions({ runtimeId, nativeId, client: { requestJson: <T>(path: string, init?: { method?: string; body?: unknown }) => request(path, init) as Promise<T> },
    verifyLocal, emit: event => events.push(event), resubscribe });
  function card() { return events.filter(event => event.type === "interaction.snapshot").at(-1)!.requests[0]!; }
  function approve(commandId = "cmd", id = card().requestId) { return track.respond(commandId, { type: "interaction.respond", extensionId: "kimiCode", requestId: id,
    response: { kind: "confirm", value: true } }); }
  return { events, track, request, card, approve, resubscribe };
}

describe("KIMI-05 native interactions", () => {
  it("projects only representable main-agent cards for this exact session, and replays a whole snapshot", () => {
    const h = harness();
    h.track.frame({ ...approval, session_id: "session_not_this_one" });
    h.track.frame({ ...approval, agent_id: "child" });
    h.track.frame({ ...approval, interaction_id: "plan", request: { ...approval.request, tool_input_display: { kind: "plan_review", plan: "plan", options: [] } } });
    h.track.frame(approval);
    h.track.frame(approval);
    expect(h.events).toEqual([]);
    h.track.finishReplay();
    expect(h.events).toEqual([{ type: "interaction.snapshot", requests: [expect.objectContaining({ kind: "confirm", toolName: "Shell", argumentSummary: "目录：/fixture\nprintf fixture" })] }]);
    h.track.close();
    const reconnected = harness();
    reconnected.track.finishReplay();
    expect(reconnected.events).toEqual([{ type: "interaction.snapshot", requests: [] }]);
  });

  it("requires the native terminal frame as well as the accepted POST, independent of order", async () => {
    for (const early of [true, false]) {
      const h = harness();
      h.track.frame(approval); h.track.finishReplay();
      h.request.mockImplementationOnce(async () => {
        if (early) h.track.frame({ ...approval, status: "ended", outcome: "approved" });
        return { outcome: "approved", ended_at: future };
      });
      await h.approve();
      expect(h.events.some(event => event.type === "command.result")).toBe(early);
      if (!early) h.track.frame({ ...approval, status: "ended", outcome: "approved" });
      expect(h.events).toContainEqual({ type: "command.result", commandId: "cmd", ok: true, status: "success" });
      expect(h.request).toHaveBeenCalledExactlyOnceWith(`/api/v1/sessions/${nativeId}/interactions/approval%2Fone`,
        { method: "POST", body: { kind: "approval", decision: "approved" } });
    }
  });

  it.each([40902, 40404])("closes a browser-won card without a success receipt (%s)", async code => {
    const h = harness(); h.track.frame(approval); h.track.finishReplay();
    const requestId = h.card().requestId;
    h.request.mockRejectedValueOnce(new KimiBusinessError(code));
    await h.approve();
    expect(h.events).toContainEqual({ type: "interaction.cancelled", requestId, reason: "cancelled" });
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", commandId: "cmd", ok: false, status: "failure" }));
    await h.approve("again", requestId);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("sends exact native option IDs with multi-select and free text; rejects cross-session and invalid answers", async () => {
    const h = harness(); h.track.frame(question); h.track.finishReplay();
    const card = h.card();
    const answer = { type: "interaction.respond" as const, extensionId: "kimiCode", requestId: card.requestId,
      response: { kind: "questionnaire" as const, answers: [{ id: "q1", values: ["a"] }, { id: "q2", values: ["y", "x"], other: "Else" }] } };
    expect(card).toMatchObject({ kind: "questionnaire", questions: [{ id: "q1", allowOther: false }, { id: "q2", question: "Choose several\nContext", allowOther: true, multiSelect: true }] });
    await h.track.respond("wrong-session", { ...answer, requestId: "from-a-different-session" });
    await h.track.respond("wrong-extension", { ...answer, extensionId: "pi" });
    await h.track.respond("wrong-option", { ...answer, response: { ...answer.response, answers: [{ id: "q1", values: ["x"] }, answer.response.answers[1]!] } });
    expect(h.request).not.toHaveBeenCalled();
    h.request.mockImplementationOnce(async () => {
      h.track.frame({ ...question, status: "ended", outcome: "answered" });
      return { outcome: "answered", ended_at: future };
    });
    await h.track.respond("valid", answer);
    expect(h.request.mock.calls[0]?.[1]?.body).toEqual({ kind: "question", method: "click",
      answers: { q1: { kind: "single", option_id: "a" }, q2: { kind: "multi_with_other", option_ids: ["y", "x"], other_text: "Else" } } });
    expect(h.events).toContainEqual({ type: "command.result", commandId: "valid", ok: true, status: "success" });
  });

  it("does not write after local validation loses its subscription or a late browser answer", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(() => gate);
    h.track.frame(approval); h.track.finishReplay();
    const submit = h.approve();
    h.track.close(); release(); await submit;
    expect(h.request).not.toHaveBeenCalled();
    expect(h.events.filter(event => event.type === "command.result")).toEqual([expect.objectContaining({ status: "unconfirmed" })]);
  });

  it("does not retry an unknown transport outcome and asks the subscription to re-read authoritative state", async () => {
    const h = harness(); h.track.frame(approval); h.track.finishReplay();
    h.request.mockRejectedValueOnce(new Error("socket closed"));
    await h.approve();
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.resubscribe).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual(expect.objectContaining({ type: "command.result", ok: false, status: "unconfirmed" }));
  });
});
