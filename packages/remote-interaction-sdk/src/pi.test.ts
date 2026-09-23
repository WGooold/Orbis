import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@pi-remote/protocol";
import {
  createPiRemoteInteraction,
  InteractionBroker,
  PI_REMOTE_BROKER_QUERY,
} from "./pi.js";

class FakeEventBus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
}

describe("Orbis Interaction integration", () => {
  it("preserves local Pi UI behavior when the remote extension is disabled", async () => {
    const events = new FakeEventBus();
    const confirm = vi.fn(async () => true);
    const client = createPiRemoteInteraction({ events }, "deploy-extension");

    await expect(client.confirm(
      { ui: { confirm, select: vi.fn(), input: vi.fn() } },
      {
        title: "Deploy?",
        description: "Production environment",
        toolName: "bash",
        argumentSummary: "kubectl apply -f deploy.yaml",
      },
    )).resolves.toBe(true);
    await expect(client.questionnaire({ title: "No phone", questions: [{
      id: "target", question: "Where?", options: [{ value: "prod", label: "Production" }],
    }] })).rejects.toThrow("requires a remote broker");
    expect(confirm).toHaveBeenCalledWith(
      "Deploy?",
      "Tool: bash\nArguments: kubectl apply -f deploy.yaml\n\nProduction environment",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("reports when an interaction starts and ends for runtime status publication", async () => {
    const published: RuntimeEvent[] = [];
    const active: boolean[] = [];
    const broker = new InteractionBroker("runtime-a", (event) => published.push(event), (value) => active.push(value));
    const result = broker.coordinate("deploy-extension", undefined, async (sdk) => {
      const answer = sdk.confirm({ title: "Approve?", timeoutMs: null });
      const requested = published.find((event) => event.type === "interaction.requested");
      if (!requested || requested.type !== "interaction.requested") throw new Error("missing request");
      expect(active).toEqual([true]);
      expect(broker.respond(requested.request.requestId, "deploy-extension", { kind: "confirm", value: true })).toBe(true);
      return answer;
    });

    await expect(result).resolves.toBe(true);
    expect(active).toEqual([true, false]);
  });

  it("resyncs one authoritative pending-request snapshot before republishing requests", async () => {
    const published: RuntimeEvent[] = [];
    const broker = new InteractionBroker("runtime-a", (event) => published.push(event));
    const result = broker.coordinate("deploy-extension", undefined, (sdk) => sdk.confirm({
      title: "Approve?",
      timeoutMs: null,
    }));
    const requested = published.find((event) => event.type === "interaction.requested");
    if (!requested || requested.type !== "interaction.requested") throw new Error("missing request");

    published.length = 0;
    broker.resync();
    expect(published[0]).toEqual({
      type: "interaction.snapshot",
      requests: [requested.request],
    });
    expect(published[1]).toEqual(requested);

    expect(broker.respond(requested.request.requestId, "deploy-extension", { kind: "confirm", value: true })).toBe(true);
    await expect(result).resolves.toBe(true);
  });

  it("discovers the runtime broker and routes a phone response to the originating extension", async () => {
    const events = new FakeEventBus();
    const published: RuntimeEvent[] = [];
    const broker = new InteractionBroker("runtime-a", (event) => published.push(event));
    events.on(PI_REMOTE_BROKER_QUERY, (data) => {
      (data as { broker?: InteractionBroker }).broker = broker;
    });
    const client = createPiRemoteInteraction({ events }, "deploy-extension");
    const result = client.select(
      { ui: { confirm: vi.fn(), select: vi.fn(() => new Promise<string | undefined>(() => {})), input: vi.fn() } },
      { title: "Target", options: [{ value: "prod", label: "Production" }] },
    );
    const requestEvent = published[0];
    if (!requestEvent || requestEvent.type !== "interaction.requested") throw new Error("missing request");

    expect(broker.respond(requestEvent.request.requestId, "other-extension", { kind: "select", value: "prod" })).toBe(false);
    expect(broker.respond(requestEvent.request.requestId, "deploy-extension", { kind: "select", value: "prod" })).toBe(true);
    await expect(result).resolves.toBe("prod");

    const form = client.questionnaire({ title: "Deployment", questions: [{
      id: "target", question: "Where?", options: [{ value: "prod", label: "Production" }],
    }] });
    const formEvent = published.at(-1);
    if (formEvent?.type !== "interaction.requested") throw new Error("missing questionnaire");
    const answers = [{ id: "target", values: ["prod"] }];
    expect(broker.respond(formEvent.request.requestId, "deploy-extension", { kind: "questionnaire", answers })).toBe(true);
    await expect(form).resolves.toEqual(answers);
  });
});
