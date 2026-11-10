// S51 / SC73: a catalog alias must not silently replace the person's native
// model preference, and reading configuration must never submit a prompt.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { claudeSessionConfiguration } from "./session-configuration-probe.js";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

it("inherits unknown Claude defaults instead of selecting the default alias", async () => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(),
    pid: 42, exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); return true; }) });
  const requests: unknown[] = [];
  stdin.on("data", bytes => {
    requests.push(JSON.parse(bytes.toString()));
    queueMicrotask(() => stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", response: {
      current_permission_mode: "manual", models: [{ value: "default", displayName: "Default", supportedEffortLevels: ["low", "high"] }],
    } } }) + "\n"));
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const catalog = await claudeSessionConfiguration("claude-fixture", "/fixture", {});
  expect(catalog.defaults).toEqual({ permissions: { mode: "default" } });
  expect(catalog.models).toMatchObject([{ value: "default" }]);
  expect(requests).toEqual([{ type: "control_request", request_id: "configuration", request: { subtype: "initialize" } }]);
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain("--model");
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
