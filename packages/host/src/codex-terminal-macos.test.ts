import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { closeMacCodexTuis, macCodexTerminalScript, parseMacCodexTuis } from "./codex-terminal-macos.js";

describe("macOS Codex terminal", () => {
  it("runs the exact CLI with literal arguments and the existing backend after rollout exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-codex-mac ' $ "));
    try {
      const sessionsRoot = join(root, "sessions");
      await mkdir(sessionsRoot);
      const sessionId = "01a19ae6-8810-7743-ba59-429765e8e3d7";
      await writeFile(join(sessionsRoot, `rollout-${sessionId}.jsonl`), "{}");
      const output = join(root, "args.json");
      const cli = join(root, "fake ' $ cli.mjs");
      await writeFile(cli, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),originator:process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE??null}));');
      const endpoint = "ws://127.0.0.1:51217";
      const script = macCodexTerminalScript({ sessionId, cwd: root, endpoint, sessionsRoot,
        codexCommand: { command: process.execPath, prefixArgs: [cli, output] } });
      await promisify(execFile)("/bin/sh", ["-c", script], { cwd: root, timeout: 5_000,
        env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" } });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({args:["resume", sessionId, "--remote", endpoint],originator:null});
      expect(script).not.toContain("wt.exe");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recognizes only remote terminal clients and keeps desktop/app-server processes out", () => {
    const started = "Mon Nov  2 12:00:00 2026";
    const line = (pid: number, tty: string, command: string) => `${pid} ${tty} ${started} ${command}`;
    const endpoint = "ws://127.0.0.1:51217";
    const output = [
      line(10, "ttys001", `/Tools/codex resume session-a --remote ${endpoint}`),
      line(11, "ttys002", `/Tools/node /My Tools/@openai/codex/bin/codex.js --remote ${endpoint}`),
      line(12, "??", `/Tools/codex app-server --listen ${endpoint}`),
      line(13, "ttys003", `/bin/echo codex resume session-a --remote ${endpoint}`),
      line(14, "ttys004", `/Tools/codex resume session-b --remote ${endpoint}9`),
      line(15, "??", `/Tools/codex resume session-c --remote ${endpoint}`),
    ].join("\n");
    expect(parseMacCodexTuis(output, endpoint).map(item => [item.pid, item.sessionId])).toEqual([[10, "session-a"], [11, undefined]]);
  });

  it("tracks its rollout waiting shell so closing an unused session cannot leave a ghost window", () => {
    const endpoint = "ws://127.0.0.1:51217";
    const script = macCodexTerminalScript({ sessionId: "session-a", cwd: "/repo", endpoint, sessionsRoot: "/sessions",
      codexCommand: { command: "/Tools/codex", prefixArgs: [] } });
    const output = `22 ttys002 Mon Nov  2 12:00:00 2026 /bin/sh -c ${script}`;
    expect(parseMacCodexTuis(output, endpoint)).toEqual([expect.objectContaining({ pid: 22, sessionId: "session-a" })]);
    expect(parseMacCodexTuis(output, "ws://127.0.0.1:51218")).toEqual([]);
  });

  it("rechecks PID identity and waits for a confirmed exit before reporting close", async () => {
    const identity = { pid: 22, started: "old", command: "codex resume a", sessionId: "a" };
    const list = vi.fn().mockResolvedValueOnce([identity]).mockResolvedValueOnce([identity])
      .mockResolvedValueOnce([identity]).mockResolvedValueOnce([]);
    const signal = vi.fn(); const wait = vi.fn(async () => {});
    expect(await closeMacCodexTuis("a", "ws://127.0.0.1:51217", { list, signal, wait })).toBe(true);
    expect(signal).toHaveBeenCalledExactlyOnceWith(22); expect(wait).toHaveBeenCalledOnce();
    list.mockResolvedValueOnce([identity]).mockResolvedValueOnce([{ ...identity, started: "reused" }]);
    signal.mockClear();
    expect(await closeMacCodexTuis("a", "ws://127.0.0.1:51217", { list, signal, wait })).toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });
});
