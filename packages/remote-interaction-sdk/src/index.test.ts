import { describe, expect, it, vi } from "vitest";
import type { InteractionRequest, QuestionnaireAnswer, RuntimeEvent } from "@pi-remote/protocol";
import {
  RemoteInteractionSdk,
  type LocalInteractionUi,
} from "./index.js";

const pending = <T>(): Promise<T> => new Promise(() => {});

const makeUi = (overrides: Partial<LocalInteractionUi> = {}): LocalInteractionUi => ({
  confirm: vi.fn(() => pending<boolean>()),
  select: vi.fn(() => pending<string | undefined>()),
  multiSelect: vi.fn(() => pending<string[] | undefined>()),
  input: vi.fn(() => pending<string | undefined>()),
  ...overrides,
});

const makeSdk = (localUi: LocalInteractionUi | null = makeUi(), timeoutMs = 5_000) => {
  const events: RuntimeEvent[] = [];
  const sdk = new RemoteInteractionSdk({
    runtimeId: "runtime-a",
    extensionId: "dangerous-ops",
    ...(localUi ? { localUi } : {}),
    publish: (event) => events.push(event),
    defaultTimeoutMs: timeoutMs,
    createId: () => "request-1",
  });
  return { sdk, events };
};

const requested = (events: RuntimeEvent[]): InteractionRequest => {
  const event = events.find((candidate) => candidate.type === "interaction.requested");
  if (!event || event.type !== "interaction.requested") throw new Error("missing request");
  return event.request;
};

describe("RemoteInteractionSdk", () => {
  it("lets a valid phone response win and ignores every later response", async () => {
    const { sdk, events } = makeSdk();
    const result = sdk.confirm({
      title: "Delete deployment?",
      description: "prod",
      toolName: "bash",
      argumentSummary: "kubectl delete deployment/api",
      confirmLabel: "Delete",
      cancelLabel: "Keep",
    });
    const request = requested(events);

    expect(request).toMatchObject({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      kind: "confirm",
      title: "Delete deployment?",
      toolName: "bash",
      argumentSummary: "kubectl delete deployment/api",
      confirmLabel: "Delete",
      cancelLabel: "Keep",
    });
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "confirm", value: true },
    })).toBe(true);
    expect(await result).toBe(true);
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "confirm", value: false },
    })).toBe(false);
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: "request-1", source: "remote" });
  });

  it("re-publishes the same pending request id when a phone reconnects", async () => {
    const { sdk, events } = makeSdk();
    const result = sdk.confirm({ title: "Approve reconnect?" });

    sdk.republishPending();
    const requests = events.filter((event) => event.type === "interaction.requested");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "confirm", value: true },
    })).toBe(true);
    await result;
  });

  it("lets the desktop response win the same request", async () => {
    const { sdk, events } = makeSdk(makeUi({ confirm: vi.fn(async () => false) }));

    await expect(sdk.confirm({ title: "Proceed?" })).resolves.toBe(false);
    expect(events).toContainEqual({ type: "interaction.resolved", requestId: "request-1", source: "local" });
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "confirm", value: true },
    })).toBe(false);
  });

  it("rejects wrong runtime, extension, response kind, and unknown request ids", () => {
    const { sdk } = makeSdk();
    const result = sdk.select({ title: "Environment", options: [{ value: "prod", label: "Production" }] });
    void result.catch(() => undefined);

    const base = {
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "select" as const, value: "prod" },
    };
    expect(sdk.respond({ ...base, runtimeId: "runtime-b" })).toBe(false);
    expect(sdk.respond({ ...base, extensionId: "other" })).toBe(false);
    expect(sdk.respond({ ...base, requestId: "missing" })).toBe(false);
    expect(sdk.respond({ ...base, response: { kind: "input", value: "prod" } })).toBe(false);
    sdk.close();
  });

  it("validates select values and input constraints before accepting remote results", async () => {
    const { sdk } = makeSdk();
    const selection = sdk.select({
      title: "Environment",
      options: [{ value: "staging", label: "Staging" }],
    });
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "select", value: "prod" },
    })).toBe(false);
    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "select", value: "staging" },
    })).toBe(true);
    await expect(selection).resolves.toBe("staging");

    const entry = makeSdk();
    const input = entry.sdk.input({
      title: "Change ticket",
      initialValue: "PI-",
      minLength: 3,
      maxLength: 8,
      secret: true,
    });
    const inputResponse = (value: string) => entry.sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "input", value },
    });

    expect(inputResponse("PI")).toBe(false);
    expect(inputResponse("PI-123456")).toBe(false);
    expect(inputResponse("PI-123")).toBe(true);
    await expect(input).resolves.toBe("PI-123");
  });

  it("publishes a multi-select request and accepts a phone values array", async () => {
    const { sdk, events } = makeSdk();
    const result = sdk.multiSelect({
      title: "Pick targets",
      description: "Choose one or more",
      options: [
        { value: "api", label: "API" },
        { value: "worker", label: "Worker" },
        { value: "db", label: "Database" },
      ],
      minSelections: 1,
      maxSelections: 2,
    });
    const request = requested(events);
    expect(request).toMatchObject({
      kind: "multi-select",
      minSelections: 1,
      maxSelections: 2,
      options: [
        { value: "api", label: "API" },
        { value: "worker", label: "Worker" },
        { value: "db", label: "Database" },
      ],
    });

    expect(sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "multi-select", values: ["api", "worker"] },
    })).toBe(true);
    await expect(result).resolves.toEqual(["api", "worker"]);
  });

  it("rejects multi-select values that are unknown, duplicated, or outside the declared bounds", async () => {
    const { sdk } = makeSdk();
    const result = sdk.multiSelect({
      title: "Pick targets",
      options: [{ value: "api", label: "API" }, { value: "db", label: "Database" }],
      minSelections: 1,
      maxSelections: 2,
    });
    void result.catch(() => undefined);
    const response = (values: string[]) => sdk.respond({
      runtimeId: "runtime-a",
      requestId: "request-1",
      extensionId: "dangerous-ops",
      response: { kind: "multi-select", values },
    });

    expect(response([])).toBe(false);
    expect(response(["api", "api"])).toBe(false);
    expect(response(["api", "missing"])).toBe(false);
    expect(response(["api"])).toBe(true);
    await expect(result).resolves.toEqual(["api"]);
  });


  it("accepts a complete questionnaire atomically without follow-up prompts or ambiguous answers", async () => {
    const { sdk, events } = makeSdk(null);
    const result = sdk.questionnaire({
      title: "Plan",
      questions: [
        { id: "targets", question: "Which targets?", multiSelect: true, allowOther: true, allowNotes: true,
          options: [{ value: "api", label: "API" }, { value: "db", label: "DB" }] },
        { id: "env", question: "Where?", allowOther: true,
          options: [{ value: "local", label: "Local" }, { value: "remote", label: "Remote" }] },
      ],
    });
    const answer: QuestionnaireAnswer[] = [
      { id: "targets", values: ["api", "db"], other: "cache", notes: "Keep the data" },
      { id: "env", values: [], other: "test machine" },
    ];
    const respond = (answers: QuestionnaireAnswer[]) => sdk.respond({
      runtimeId: "runtime-a", extensionId: "dangerous-ops", requestId: "request-1",
      response: { kind: "questionnaire", answers },
    });
    for (const invalid of [
      [answer[0]!], // Missing question.
      [answer[0]!, answer[0]!], // Duplicate question.
      [{ ...answer[0]!, id: "unknown" }, answer[1]!],
      [{ ...answer[0]!, values: ["unknown"] }, answer[1]!],
      [{ ...answer[0]!, values: ["api", "api"] }, answer[1]!],
      [answer[0]!, { id: "env", values: ["local", "remote"] }],
      [answer[0]!, { id: "env", values: ["local"], other: "elsewhere" }],
      [answer[0]!, { id: "env", values: [], other: "   " }],
      [answer[0]!, { id: "env", values: ["local"], notes: "not allowed" }],
    ]) expect(respond(invalid)).toBe(false);
    expect(respond(answer)).toBe(true);
    await expect(result).resolves.toEqual(answer);
    expect(events.filter((event) => event.type === "interaction.requested")).toHaveLength(1);
    expect(respond(answer)).toBe(false);
  });

  it("rejects a local UI value that violates the same constraints as a phone response", async () => {
    const { sdk, events } = makeSdk(makeUi({
      input: vi.fn(async () => "too-long"),
    }));

    await expect(sdk.input({ title: "Short value", maxLength: 3 })).rejects.toMatchObject({ code: "cancelled" });
    expect(events).toContainEqual({
      type: "interaction.cancelled",
      requestId: "request-1",
      reason: "cancelled",
    });
  });

  it("turns a synchronously failing local UI adapter into an explicit cancellation", async () => {
    const { sdk, events } = makeSdk(makeUi({
      confirm: vi.fn(() => { throw new Error("UI unavailable"); }),
    }));

    await expect(sdk.confirm({ title: "Approve?" })).rejects.toMatchObject({ code: "cancelled" });
    expect(events).toContainEqual({
      type: "interaction.cancelled",
      requestId: "request-1",
      reason: "cancelled",
    });
  });

  it("keeps a request without a timeout pending past the default and Node's timer clamp", async () => {
    vi.useFakeTimers();
    try {
      const { sdk, events } = makeSdk(makeUi(), 25);
      const result = sdk.confirm({ title: "Wait for the phone", timeoutMs: null });
      expect(requested(events).expiresAt).toBe(Number.MAX_SAFE_INTEGER);

      // Past the configured default and far past Node's 2^31 - 1 ms timer clamp,
      // where a naive setTimeout would have fired immediately.
      await vi.advanceTimersByTimeAsync(3_000_000_000);
      expect(sdk.respond({
        runtimeId: "runtime-a",
        requestId: "request-1",
        extensionId: "dangerous-ops",
        response: { kind: "confirm", value: true },
      })).toBe(true);
      await expect(result).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes explicit cancellation and timeout while transport loss keeps the request recoverable", async () => {
    const noTimeout = makeSdk();
    const noTimeoutController = new AbortController();
    const noTimeoutResult = noTimeout.sdk.confirm({
      title: "Abort me",
      timeoutMs: null,
      signal: noTimeoutController.signal,
    });
    const noTimeoutExpectation = expect(noTimeoutResult).rejects.toMatchObject({ code: "cancelled" });
    noTimeoutController.abort();
    await noTimeoutExpectation;
    expect(noTimeout.events).toContainEqual({
      type: "interaction.cancelled",
      requestId: "request-1",
      reason: "cancelled",
    });

    const remoteCancelled = makeSdk();
    const remoteResult = remoteCancelled.sdk.confirm({ title: "Cancel from phone" });
    const remoteExpectation = expect(remoteResult).rejects.toMatchObject({ code: "cancelled" });
    const cancellation = {
      runtimeId: "runtime-a", extensionId: "dangerous-ops", requestId: "request-1",
      response: { kind: "cancel" as const },
    };
    expect(remoteCancelled.sdk.respond({ ...cancellation, extensionId: "wrong" })).toBe(false);
    expect(remoteCancelled.sdk.respond(cancellation)).toBe(true);
    await remoteExpectation;
    expect(remoteCancelled.sdk.respond(cancellation)).toBe(false);

    const cancelled = makeSdk();
    const controller = new AbortController();
    const cancelledResult = cancelled.sdk.input({ title: "Name", signal: controller.signal });
    const cancelledExpectation = expect(cancelledResult).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await cancelledExpectation;

    vi.useFakeTimers();
    try {
      const timedOut = makeSdk(makeUi(), 100);
      const timedOutResult = timedOut.sdk.confirm({ title: "Approve?" });
      const timeoutExpectation = expect(timedOutResult).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(100);
      await timeoutExpectation;
    } finally {
      vi.useRealTimers();
    }

    const disconnected = makeSdk(null);
    const disconnectedResult = disconnected.sdk.confirm({ title: "Approve?", timeoutMs: null });
    disconnected.sdk.remoteDisconnected();
    expect(disconnected.events.filter((event) => event.type === "interaction.cancelled")).toHaveLength(0);
    expect(disconnected.sdk.respond({
      runtimeId: "runtime-a",
      extensionId: "dangerous-ops",
      requestId: "request-1",
      response: { kind: "confirm", value: true },
    })).toBe(true);
    await expect(disconnectedResult).resolves.toBe(true);

    const closed = makeSdk(null);
    const closedResult = closed.sdk.confirm({ title: "Approve?", timeoutMs: null });
    closed.sdk.close();
    await expect(closedResult).rejects.toMatchObject({ code: "owner_closed" });
    expect(closed.events).toContainEqual({
      type: "interaction.cancelled",
      requestId: "request-1",
      reason: "owner_closed",
    });
  });
});
