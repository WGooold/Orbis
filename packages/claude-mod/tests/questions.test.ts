import { expect, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

const questions = [{ question: "Which color?", header: "Color", multiSelect: false,
  options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }];

function eventTypes(world: ReturnType<typeof setup>["world"]): string[] {
  return world.requests.filter(request => request.url.endsWith("/event"))
    .map(request => (request.body.event as { type: string }).type);
}

// CLAUDE-QUESTION-RACE-01: the phone answer ends an open native dialog. The Host must acknowledge the
// question before the dialog opens, or the classic PreToolUse Hook would block it again.
test("returns a phone answer while the native question dialog is still open", async ($, on) => {
  const { clock, world } = setup(on);
  world.toolDelay = 60_000;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const pending = $.tool.call({ tool: "AskUserQuestion", tool_use_id: "question-1", questions });
  await clock.settle();
  expect(world.toolCalls).toHaveLength(1);
  const requested = world.requests.find(request => (request.body.event as { type?: string } | undefined)?.type === "question.requested");
  expect(requested?.body.event).toEqual({ type: "question.requested", toolCallId: "question-1", questions });

  world.questionAnswers = [{ toolCallId: "question-1", answers: { "Which color?": "Blue" } }];
  await clock.advance(750);
  const result = await pending;
  expect(result.result).toEqual({ questions, answers: { "Which color?": "Blue" } });
  expect(eventTypes(world).filter(type => type.startsWith("tool.") || type.startsWith("question.")))
    .toEqual(["tool.started", "question.requested", "tool.finished"]);
});

// CLAUDE-QUESTION-RACE-01: a computer answer keeps the native result and reports the finished call,
// which the Host uses to close the phone card; a later repeated phone answer is ignored.
test("keeps the native answer when the computer answers first", async ($, on) => {
  const { clock, world } = setup(on);
  world.toolDelay = 2_000;
  world.toolResult = "native-answer";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const pending = $.tool.call({ tool: "AskUserQuestion", tool_use_id: "question-2", questions });
  await clock.advance(2_000);
  const result = await pending;
  expect(result.result).toBe("native-answer");
  world.questionAnswers = [{ toolCallId: "question-2", answers: { "Which color?": "Red" } }];
  await clock.advance(750);
  expect(world.toolCalls).toHaveLength(1);
  const finished = world.requests.find(request => (request.body.event as { type?: string } | undefined)?.type === "tool.finished");
  expect(finished?.body.event).toMatchObject({ toolCallId: "question-2", result: "native-answer", isError: false });
});

// CLAUDE-QUESTION-RACE-02: an older Host refuses the event, so the plugin only runs the native call and
// the bundled classic Hook keeps that Host's existing phone path.
test("runs only the native call when the Host cannot show the question", async ($, on) => {
  const { clock, world } = setup(on);
  world.questionRefused = true;
  world.toolResult = "native-only";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const result = await $.tool.call({ tool: "AskUserQuestion", tool_use_id: "question-3", questions });
  expect(result.result).toBe("native-only");
  expect(world.toolCalls).toHaveLength(1);
});

// CLAUDE-QUESTION-RACE-01: a phone cancellation refuses the call the same way the classic Hook's deny did.
test("returns a phone cancellation as a refusal", async ($, on) => {
  const { clock, world } = setup(on);
  world.toolDelay = 60_000;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const pending = $.tool.call({ tool: "AskUserQuestion", tool_use_id: "question-4", questions });
  await clock.settle();
  world.questionAnswers = [{ toolCallId: "question-4", deny: "Claude Code 问题已取消" }];
  await clock.advance(750);
  const result = await pending;
  expect(result.deny).toBe("Claude Code 问题已取消");
});

// CLAUDE-QUESTION-RACE-01: a subagent's question races under its own agent identity, and its
// task completion (not a main tool event) closes the phone card.
test("races a subagent question under its agent identity", async ($, on) => {
  const { clock, world } = setup(on);
  world.toolDelay = 60_000;
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const pending = $.tool.call({ tool: "AskUserQuestion", tool_use_id: "child-question", questions, agentId: "child" });
  await clock.settle();
  world.questionAnswers = [{ toolCallId: "child-question", answers: { "Which color?": "Red" } }];
  await clock.advance(750);
  expect((await pending).result).toEqual({ questions, answers: { "Which color?": "Red" } });
  const events = world.requests.map(request => request.body.event as { type: string } | undefined).filter(Boolean);
  expect(events).toContainEqual({ type: "question.requested", toolCallId: "child-question", agentId: "child", questions });
  expect(events).toContainEqual(expect.objectContaining({ type: "task.tool.finished", agentId: "child", toolCallId: "child-question" }));
  expect(events.some(event => event?.type === "tool.started" || event?.type === "tool.finished")).toBe(false);
});
