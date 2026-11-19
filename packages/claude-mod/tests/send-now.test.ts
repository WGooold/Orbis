import { expect, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

function commandResultEvents(world: ReturnType<typeof setup>["world"]) {
  return world.requests
    .filter(request => request.url.endsWith("/event")
      && (request.body.event as { type?: string } | undefined)?.type === "command.result")
    .map(request => request.body.event as {
      type: string;
      commandId: string;
      ok: boolean;
      status: string;
      error?: string;
      result?: { messageId?: string };
    });
}

// Advertises prompt.sendNow so the Host knows this plugin can interrupt active turns on steer.
test("advertises prompt.sendNow capability in hello", async ($, on) => {
  const { clock, hellos } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  const capabilities = hellos()[0]?.body.capabilities as string[] | undefined;
  expect(capabilities).toContain("prompt.sendNow");
});

// CLAUDE-SEND-NOW-01: steer aborts the active turn and immediately submits the new prompt.
test("steers an active turn by aborting before submitting the prompt", async ($, on) => {
  const { clock, world } = setup(on);
  world.denyPrompt = false;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "long task", turnId: "turn-busy" });

  world.commands = [{
    commandId: "cmd-steer",
    command: { type: "user_message", text: "switch now", messageId: "msg-steer", delivery: "steer" },
  }];
  await clock.advance(750);
  expect(world.aborts).toEqual(["turn-busy"]);
  expect(world.submits).toBe(1);
  expect(world.submittedTexts).toEqual(["switch now"]);

  world.commands = [];
  await clock.advance(3000);
  expect(commandResultEvents(world)).toContainEqual({
    type: "command.result",
    commandId: "cmd-steer",
    ok: true,
    status: "success",
    result: { messageId: "msg-steer" },
  });
});

// CLAUDE-SEND-NOW-02: blank prompts fail validation before aborting an active turn.
test("rejects blank steer prompts before aborting the active turn", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "long task", turnId: "turn-busy" });

  world.commands = [{
    commandId: "cmd-empty",
    command: { type: "user_message", text: "   ", messageId: "msg-empty", delivery: "steer" },
  }];
  await clock.advance(750);
  world.commands = [];
  await clock.advance(750);

  expect(world.aborts).toEqual([]);
  expect(world.submits).toBe(0);
  expect(commandResultEvents(world)).toContainEqual(expect.objectContaining({
    commandId: "cmd-empty",
    ok: false,
    status: "failure",
    error: "prompt_empty",
  }));
});

// CLAUDE-SEND-NOW-03: if abort rejects while still running, prompt was never submitted -> failure (not unconfirmed).
test("reports failure instead of unconfirmed when abort fails while turn stays active", async ($, on) => {
  const { clock, world } = setup(on);
  world.abortError = "turn_abort_failed";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "long task", turnId: "turn-busy" });

  world.commands = [{
    commandId: "cmd-abort-fail",
    command: { type: "user_message", text: "switch", messageId: "msg-abort-fail", delivery: "steer" },
  }];
  await clock.advance(750);
  world.commands = [];
  await clock.advance(750);

  expect(world.submits).toBe(0);
  expect(commandResultEvents(world)).toContainEqual(expect.objectContaining({
    commandId: "cmd-abort-fail",
    ok: false,
    status: "failure",
  }));
});

// CLAUDE-SEND-NOW-04: if abort raced with natural completion, continue submitting once idle.
test("continues submitting when abort throws only because the turn already finished", async ($, on) => {
  const { clock, world } = setup(on);
  world.denyPrompt = false;
  let completedDuringAbort = false;
  on("turn.abort", async () => {
    if (!completedDuringAbort) {
      completedDuringAbort = true;
      await $.turn.complete({ turnId: "turn-racing", answer: "done", durationMs: 100, reason: "answer", isAborted: false });
    }
    return { deny: "turn already ended" };
  });

  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "almost done", turnId: "turn-racing" });

  world.commands = [{
    commandId: "cmd-race",
    command: { type: "user_message", text: "after race", messageId: "msg-race", delivery: "steer" },
  }];
  await clock.advance(750);
  world.commands = [];
  await clock.advance(3000);

  expect(world.submits).toBe(1);
  expect(commandResultEvents(world)).toContainEqual({
    type: "command.result",
    commandId: "cmd-race",
    ok: true,
    status: "success",
    result: { messageId: "msg-race" },
  });
});

// CLAUDE-SEND-NOW-05: an unexpected error during prompt.submit remains unconfirmed.
test("reports unconfirmed when prompt.submit throws after aborting", async ($, on) => {
  const { clock, world } = setup(on);
  world.submitError = "bridge crashed";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "long task", turnId: "turn-busy" });

  world.commands = [{
    commandId: "cmd-submit-throw",
    command: { type: "user_message", text: "risky send", delivery: "steer" },
  }];
  await clock.advance(750);
  world.commands = [];
  await clock.advance(3000);

  expect(world.aborts).toEqual(["turn-busy"]);
  expect(world.submits).toBe(1);
  expect(commandResultEvents(world)).toContainEqual(expect.objectContaining({
    commandId: "cmd-submit-throw",
    ok: false,
    status: "unconfirmed",
  }));
});

// CLAUDE-SEND-NOW-06: steer waits behind an already-running stop command rather than double-aborting.
test("defers steer behind an already running stop command until the turn finishes", async ($, on) => {
  const { clock, world } = setup(on);
  world.denyPrompt = false;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "long task", turnId: "turn-stopping" });

  world.commands = [{ commandId: "cmd-stop", command: { type: "stop" } }];
  await clock.advance(750);
  expect(world.aborts).toEqual(["turn-stopping"]);

  world.commands = [
    { commandId: "cmd-stop", command: { type: "stop" } },
    { commandId: "cmd-steer-after-stop", command: { type: "user_message", text: "next", delivery: "steer" } },
  ];
  await clock.advance(750);
  expect(world.aborts).toEqual(["turn-stopping"]);
  expect(world.submits).toBe(0);

  await $.turn.complete({ turnId: "turn-stopping", answer: "", durationMs: 1500, reason: "aborted", isAborted: true });
  world.commands = [{ commandId: "cmd-steer-after-stop", command: { type: "user_message", text: "next", delivery: "steer" } }];
  await clock.advance(750);
  expect(world.aborts).toEqual(["turn-stopping"]);
  expect(world.submits).toBe(1);
});
