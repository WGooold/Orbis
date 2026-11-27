import { expect, it } from "vitest";
import { checkServiceCliVersion } from "./local-agent-start.js";

const check = (output: string, name: string, minimum: string, aliases?: string[]) => checkServiceCliVersion(
  { command: process.execPath, prefixArgs: ["-e", `console.log(${JSON.stringify(output)})`, "--"] },
  process.cwd(), process.env, AbortSignal.timeout(4_000), name, minimum, aliases,
);

it.each([
  ["2.3.2", "OpenCode", "2.3.2"],
  ["v2.10.0", "OpenCode", "2.3.2"],
  ["OpenClaw 2026.12.1 (fixture)", "OpenClaw", "2026.11.5"],
  ["Kimi Code 2.7.0", "Kimi Code", "2.6.3", ["Kimi Code", "kimi"]],
] as const)("accepts CLI output %s at or above its minimum", async (output, name, minimum, aliases?: readonly string[]) => {
  await expect(check(output, name, minimum, aliases ? [...aliases] : undefined)).resolves.toBeUndefined();
});

it.each(["2.3.1", "2.3.2-rc.1", "OpenCode 2.4.0\nunrelated diagnostic", "not a version"])("rejects CLI output %s below the minimum or unparseable", async output => {
  await expect(check(output, "OpenCode", "2.3.2")).rejects.toMatchObject({ reason: "unsupported" });
});
