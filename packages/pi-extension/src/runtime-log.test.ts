import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPiExtensionRuntimeDiagnostic,
  logPiExtensionRuntimeEvent,
  piExtensionRuntimeLogPath,
} from "./runtime-log.js";

describe("Pi extension runtime logging", () => {
  it("writes reload diagnostics as one JSONL record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-runtime-log-"));
    const logPath = join(directory, "logs", "runtime.log");

    await logPiExtensionRuntimeEvent("extension_reloaded", {
      reason: "reload",
      entryPoint: "file:///D:/pi-remote-extention/packages/pi-extension/dist/index.js",
    }, {
      env: { PI_REMOTE_RUNTIME_LOG: logPath },
      now: () => Date.parse("2026-09-03T00:00:00.000Z"),
      pid: 12345,
    });

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([{
      timestamp: "2026-09-03T00:00:00.000Z",
      level: "info",
      event: "extension_reloaded",
      pid: 12345,
      reason: "reload",
      entryPoint: "file:///D:/pi-remote-extention/packages/pi-extension/dist/index.js",
    }]);
  });

  it("keeps the diagnostic callback usable after its source context becomes stale", () => {
    let stale = false;
    const context = {
      get cwd(): string {
        if (stale) throw new Error("stale context");
        return "D:/workspace";
      },
    };
    const events: Array<{ event: string; cwd: string | undefined }> = [];
    const diagnostic = createPiExtensionRuntimeDiagnostic(context.cwd, (event, _fields, options) => {
      events.push({ event, cwd: options.cwd });
    });

    stale = true;
    expect(() => diagnostic("pi.reload.resolved")).not.toThrow();
    expect(events).toEqual([{ event: "pi.reload.resolved", cwd: "D:/workspace" }]);
  });

  it("honors the configured level and stays silent when disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-remote-runtime-log-"));
    const logPath = join(directory, "runtime.log");

    await logPiExtensionRuntimeEvent("bridge.command.received", { commandId: "debug-only" }, {
      env: { PI_REMOTE_RUNTIME_LOG: logPath, PI_REMOTE_RUNTIME_LOG_LEVEL: "error" },
    });
    await logPiExtensionRuntimeEvent("pi.reload.failed", { error: "reload failed" }, {
      env: { PI_REMOTE_RUNTIME_LOG: logPath, PI_REMOTE_RUNTIME_LOG_LEVEL: "error" },
    });

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: "pi.reload.failed", level: "error" });

    const disabledPath = join(directory, "disabled.log");
    await logPiExtensionRuntimeEvent("extension_loaded", {}, {
      env: { PI_REMOTE_RUNTIME_LOG: disabledPath, PI_REMOTE_RUNTIME_LOG_LEVEL: "off" },
    });
    await expect(readFile(disabledPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a relative override against the Pi working directory", () => {
    expect(piExtensionRuntimeLogPath({ PI_REMOTE_RUNTIME_LOG: "logs/runtime.log" }, "D:/workspace"))
      .toBe("D:\\workspace\\logs\\runtime.log");
  });
});
