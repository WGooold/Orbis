import { expect, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

test("stops the native turn then submits once, and acknowledges the native result", async ($, on) => {
  const { clock, world, hellos } = setup(on);
  world.denyPrompt = false;
  world.draft = "unfinished local draft";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  expect(hellos()[0]?.body.capabilities).toContain("prompt.sendNow");
  await $.turn.start({ text: "original task", turnId: "main" });
  world.commands = [{ commandId: "now", command: { type: "user_message", text: "change direction", delivery: "steer" } }];
  await clock.advance(750);
  world.commands = [];
  expect(world.nativeCalls).toEqual(["abort", "submit"]);
  expect(world.aborts).toEqual(["main"]);
  expect(world.submits).toBe(1);
  expect(world.requests.some(request => (request.body.event as { commandId?: string } | undefined)?.commandId === "now")).toBe(false);
  expect(world.draft).toBe("unfinished local draft");
  expect(world.draftReads).toBe(0);
  expect(world.draftWrites).toBe(0);
  await clock.advance(3000);
  const results = world.requests.flatMap(request => request.body.event ? [request.body.event as Record<string, unknown>] : [])
    .filter(event => event.type === "command.result" && event.commandId === "now");
  expect(results).toEqual([{ type: "command.result", commandId: "now", ok: true, status: "success" }]);
  expect(world.submits).toBe(1);
});

test("reports when the native prompt is dropped after the previous turn was stopped", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "main" });
  world.commands = [{ commandId: "denied", command: { type: "user_message", text: "phone message", delivery: "steer" } }];
  await clock.advance(750);
  world.commands = [];
  await clock.advance(3000);
  expect(world.aborts).toEqual(["main"]);
  expect(world.requests.some(request => {
    const event = request.body.event as Record<string, unknown> | undefined;
    return event?.commandId === "denied" && event.ok === false && event.status === "failure" &&
      typeof event.error === "string" && event.error.includes("当前轮已停止，消息未提交") && event.error.includes("Test: no model is called");
  })).toBe(true);
});

test("submits an idle steer without aborting", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  world.commands = [{ commandId: "idle", command: { type: "user_message", text: "phone message", delivery: "steer" } }];
  await clock.advance(750);
  world.commands = [];
  expect(world.nativeCalls).toEqual(["submit"]);
  expect(world.draftReads).toBe(0);
  expect(world.draftWrites).toBe(0);
});

for (const text of ["  ", "  /model"]) {
  test(`validates a busy steer before stopping (${JSON.stringify(text)})`, async ($, on) => {
    const { clock, world } = setup(on);
    await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
    await clock.settle();
    await $.turn.start({ text: "original task", turnId: "main" });
    world.commands = [{ commandId: "invalid", command: { type: "user_message", text, delivery: "steer" } }];
    await clock.advance(750);
    expect(world.nativeCalls).toEqual([]);
    expect(world.requests.some(request => {
      const event = request.body.event as Record<string, unknown> | undefined;
      return event?.commandId === "invalid" && event.status === "failure";
    })).toBe(true);
  });
}

test("refuses a steer during native compaction without aborting or submitting", async ($, on) => {
  const { clock, world } = setup(on);
  on("session.compact", async (_$, event) => {
    await clock.sleep(3000);
    return { messages: event.messages };
  });
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  const compacting = $.session.compact({ trigger: "manual", messages: [{ role: "user", text: "existing context", toolUses: [], toolResults: [] }] });
  await clock.settle();
  world.commands = [{ commandId: "compacting", command: { type: "user_message", text: "phone message", delivery: "steer" } }];
  await clock.advance(750);
  world.commands = [];
  expect(world.nativeCalls).toEqual([]);
  expect(world.requests.some(request => {
    const event = request.body.event as Record<string, unknown> | undefined;
    return event?.commandId === "compacting" && event.status === "failure" && event.error === "runtime_busy";
  })).toBe(true);
  await clock.advance(3000);
  await compacting;
});

test("refuses another steer while a native submission is waiting", async ($, on) => {
  const { clock, world } = setup(on);
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();
  await $.turn.start({ text: "original task", turnId: "main" });
  world.commands = [
    { commandId: "first", command: { type: "user_message", text: "first message", delivery: "steer" } },
    { commandId: "second", command: { type: "user_message", text: "second message", delivery: "steer" } },
  ];
  await clock.advance(750);
  world.commands = [];
  expect(world.nativeCalls).toEqual(["abort", "submit"]);
  expect(world.requests.some(request => {
    const event = request.body.event as Record<string, unknown> | undefined;
    return event?.commandId === "second" && event.status === "failure" && event.error === "runtime_busy";
  })).toBe(true);
});
