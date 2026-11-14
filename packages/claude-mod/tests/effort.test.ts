import type { On, TurnStepInput } from "claude-code";
import { expect, mock, test, type Engine } from "claude-code/testing";
import { setup } from "./fixtures.ts";

function fixture(on: On) {
  const result = setup(on);
  mock.session(on);
  const seen: TurnStepInput[] = [];
  on("turn.step", async function* (_$, event) {
    seen.push(event);
    yield { kind: "text", index: 0, text: "synthetic" };
    return { turnId: event.turnId, index: event.index, answer: "done", toolUses: [], stopReason: "end_turn", usage: null };
  });
  const states = () => result.world.requests.flatMap(request => {
    const event = request.body.event as { type?: string; state?: Record<string, unknown> } | undefined;
    return event?.type === "session.state" && event.state?.model ? [event.state] : [];
  });
  return { ...result, seen, states };
}
async function step($: Engine, input: TurnStepInput) {
  const stream = $.turn.step(input);
  for await (const chunk of stream) { void chunk; }
  await stream.result;
}
async function complete($: Engine, turnId: string) {
  await $.turn.complete({ turnId, answer: "done", durationMs: 1, reason: "answer", isAborted: false });
}

// SC87: --effort and native defaults are resolved in turn.step, not settings.read().
// Preserve that observation through completion; a file may omit it or hold an older value.
for (const setting of [undefined, "low"]) {
  test(`retains native effort after repeated replies when the file holds ${setting ?? "no effort"}`, async ($, on) => {
    const { clock, world, states } = fixture(on);
    world.effortSetting = setting;
    await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
    await clock.settle();
    expect(states().at(-1)?.effort).toBe(setting);
    for (const turnId of ["first", "second"]) {
      await $.turn.start({ text: "synthetic", turnId });
      await step($, { turnId, index: 0, model: world.model, effort: "high", messageCount: 1 });
      await complete($, turnId);
      await clock.settle();
      expect(states().at(-1)).toMatchObject({ effort: "high", currentTurnConfiguration: null });
      await clock.advance(15_000);
      expect(states().at(-1)?.effort).toBe("high");
    }
  });
}

// A phone change is still a next-turn selection. A completed request must not overwrite it.
test("keeps a pending phone depth distinct from the observed turn and preserves it at idle", async ($, on) => {
  const { clock, world, seen, states } = fixture(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "synthetic", turnId: "first" });
  await step($, { turnId: "first", index: 0, model: world.model, effort: "high", messageCount: 1 });
  world.commands = [{ commandId: "depth", command: { type: "slash", name: "effort", args: "low" } }];
  await clock.advance(750);
  world.commands = [];
  expect(states().at(-1)).toMatchObject({ effort: "low", currentTurnConfiguration: { thinkingLevel: "high" } });
  await step($, { turnId: "first", index: 1, model: world.model, effort: "high", messageCount: 2 });
  await complete($, "first");
  await clock.settle();
  expect(states().at(-1)).toMatchObject({ effort: "low", currentTurnConfiguration: null });
  await $.turn.start({ text: "synthetic", turnId: "second" });
  await step($, { turnId: "second", index: 0, model: world.model, effort: "high", messageCount: 3 });
  expect(seen.map(event => event.effort)).toEqual(["high", "high", "low"]);
});

// Fallbacks and child requests are execution facts, not the main session's next selection.
test("does not let fallback or child requests replace the main native effort", async ($, on) => {
  const { clock, world, states } = fixture(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "synthetic", turnId: "main" });
  await step($, { turnId: "main", index: 0, model: world.model, effort: "high", messageCount: 1 });
  await step($, { turnId: "child", agentId: "child", index: 0, model: world.model, effort: "max", messageCount: 1 });
  await step($, { turnId: "main", index: 1, model: "fallback", effort: "low", messageCount: 2 });
  await complete($, "main");
  await clock.settle();
  expect(states().at(-1)).toMatchObject({ model: world.model, effort: "high", currentTurnConfiguration: null });
});

// Invalidate the observation on a real settings/model change; reverting a setting cannot revive it.
test("invalidates observed effort when native model or settings change", async ($, on) => {
  const { clock, world, states } = fixture(on);
  world.effortSetting = "low";
  world.modelSetting = "sonnet";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "synthetic", turnId: "first" });
  await step($, { turnId: "first", index: 0, model: world.model, effort: "high", messageCount: 1 });
  await complete($, "first");
  await clock.settle();
  expect(states().at(-1)?.effort).toBe("high");
  world.effortSetting = "medium";
  await clock.advance(15_000);
  expect(states().at(-1)?.effort).toBe("medium");
  world.effortSetting = "low";
  await clock.advance(15_000);
  expect(states().at(-1)?.effort).toBe("low");
  await $.turn.start({ text: "synthetic", turnId: "second" });
  await step($, { turnId: "second", index: 0, model: world.model, effort: "max", messageCount: 1 });
  await complete($, "second");
  await clock.settle();
  expect(states().at(-1)?.effort).toBe("max");
  world.modelSetting = "opusplan";
  await clock.advance(15_000);
  expect(states().at(-1)?.effort).toBe("low");
  world.effortSetting = undefined;
  world.model = "different-model";
  await clock.advance(15_000);
  expect(states().at(-1)?.effort).toBeUndefined();
});

// An unsupported/omitted native effort cannot be backfilled from a prior turn or future selection.
test("leaves an omitted native depth empty after a supported request", async ($, on) => {
  const { clock, world, states } = fixture(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  for (const [turnId, effort] of [["supported", "high"], ["unspecified", undefined]] as const) {
    await $.turn.start({ text: "synthetic", turnId });
    await step($, { turnId, index: 0, model: world.model, ...(effort ? { effort } : {}), messageCount: 1 });
    await complete($, turnId);
    await clock.settle();
    expect(states().at(-1)?.effort).toBe(effort);
  }
});

// A /clear or /resume in the same process cannot give a different session the old depth.
test("does not reuse an observed depth after the native session identity changes", async ($, on) => {
  const { clock, world, states } = fixture(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "synthetic", turnId: "first" });
  await step($, { turnId: "first", index: 0, model: world.model, effort: "high", messageCount: 1 });
  await complete($, "first");
  await clock.settle();
  expect(states().at(-1)?.effort).toBe("high");
  world.sessionId = "another-native-session";
  await clock.advance(750);
  expect(states().at(-1)?.effort).toBeUndefined();
});
