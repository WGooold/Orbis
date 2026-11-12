// S51 / SC73: a catalog alias must not silently replace the person's native
// model preference, and reading configuration must never submit a prompt.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { claudeSessionConfiguration } from "./session-configuration-probe.js";

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])("inherits Claude defaults through native and Windows batch entries (batch=%s)", async batch => {
  // SC82: the configuration reader must wrap .cmd exactly like authentication/startup.
  if (batch) vi.stubGlobal("process", { ...process, platform: "win32" });
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(),
    pid: batch ? undefined : 42, exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => { child.exitCode = 0; child.emit("exit", 0); return true; }) });
  const killGroup = vi.spyOn(process, "kill").mockImplementation(() => { child.exitCode = 0; child.emit("exit", 0); return true; });
  const requests: unknown[] = [];
  stdin.on("data", bytes => {
    requests.push(JSON.parse(bytes.toString()));
    queueMicrotask(() => stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", response: {
      current_permission_mode: "manual", models: [{ value: "default", displayName: "Default", supportedEffortLevels: ["low", "high"] }],
    } } }) + "\n"));
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const catalog = await claudeSessionConfiguration(batch ? "C:\\Tools With Spaces\\claude.cmd" : "claude-fixture", "/fixture", {});
  expect(catalog.defaults).toEqual({ permissions: { mode: "default" } });
  expect(catalog.models).toMatchObject([{ value: "default" }]);
  expect(requests).toEqual([{ type: "control_request", request_id: "configuration", request: { subtype: "initialize" } }]);
  const call = vi.mocked(spawn).mock.calls.at(-1)!;
  expect(call[1]).not.toContain("--model");
  if (batch) {
    expect(call[0]).toBe("cmd.exe");
    expect(call[1]?.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(call[2]).toMatchObject({ windowsVerbatimArguments: true });
  } else if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  else expect(killGroup).toHaveBeenCalledWith(-42, "SIGTERM");
});
