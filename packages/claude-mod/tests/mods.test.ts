import { expect, test } from "claude-code/testing";

test("forwards native tool events without replacing the tool result", async ($, on) => {
  let observed = false;
  on("tool.call", () => {
    observed = true;
    return { result: "orbis-test-result" };
  });

  const result = await $.tool.call({ tool: "Bash", command: "echo this command must not run" });
  expect(observed).toBe(true);
  expect(result.result).toBe("orbis-test-result");
});
