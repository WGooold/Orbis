import { expect, test } from "claude-code/testing";
import { setup } from "./fixtures.ts";

// Verify the Orbis bridge delivers ordered tool events without replacing the native result.
test("forwards native tool events without replacing the tool result", async ($, on) => {
  const { clock, world } = setup(on);
  world.toolResult = "orbis-test-result";
  await $.session.start({ cwd: "/workspace", surface: "terminal", isInteractive: true });
  await clock.settle();

  const result = await $.tool.call({ tool: "Bash", tool_use_id: "tool-delivery", command: "echo this command must not run" });
  expect(world.toolCalls).toHaveLength(1);
  expect(result.result).toBe("orbis-test-result");
  const deliveries = world.requests.filter(request => request.url.endsWith("/event")
    && ["tool.started", "tool.finished"].includes((request.body.event as { type: string })?.type));
  expect(deliveries.map(request => request.body)).toEqual([
    { runtimeId: "claude:same-native-session", generation: "first-generation",
      event: { type: "tool.started", toolCallId: "tool-delivery", toolName: "Bash", arguments: { command: "echo this command must not run" } } },
    { runtimeId: "claude:same-native-session", generation: "first-generation",
      event: { type: "tool.finished", toolCallId: "tool-delivery", toolName: "Bash", result: "orbis-test-result", isError: false } },
  ]);
});
