import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalClaudeProcessControl, type ClaudeProcessIdentity } from "./claude-process.js";

const identity: ClaudeProcessIdentity = { pid: 424242, started: "start-1", executable: "/usr/local/bin/claude", command: "claude" };

describe("Claude process close", () => {
  it.skipIf(process.platform === "win32")("verifies and terminates an isolated real process without touching its sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-close-process-"));
    const executable = join(root, "claude");
    await symlink("/bin/sleep", executable);
    const child = spawn(executable, ["30"], { stdio: "ignore" });
    const sibling = spawn(executable, ["30"], { stdio: "ignore" });
    try {
      await Promise.all([once(child, "spawn"), once(sibling, "spawn")]);
      const control = new LocalClaudeProcessControl();
      const captured = await control.capture(child.pid!);
      expect(captured).toMatchObject({ pid: child.pid, executable });
      const exited = once(child, "exit");
      await control.terminate(captured!, () => true);
      await exited;
      expect(child.signalCode).toBe("SIGTERM");
      expect(await control.capture(sibling.pid!)).toBeDefined();
    } finally {
      child.kill("SIGKILL"); sibling.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("escalates only the same registered process if graceful termination times out", async () => {
    let killed = false;
    const signal = vi.fn((_pid: number, kind: NodeJS.Signals) => { if (kind === "SIGKILL") killed = true; });
    const control = new LocalClaudeProcessControl(async () => killed ? undefined : identity, signal);
    await control.terminate(identity, () => true);
    expect(signal.mock.calls).toEqual([[identity.pid, "SIGTERM"], [identity.pid, "SIGKILL"]]);
  });
  it("accepts native and npm Claude but refuses the Host, shell and unrelated node processes", async () => {
    const read = vi.fn(async () => identity);
    const control = new LocalClaudeProcessControl(read, vi.fn());
    expect(await control.capture(identity.pid)).toEqual(identity);
    for (const pid of [0, 1, -1, 1.5, process.pid, process.ppid]) expect(await control.capture(pid)).toBeUndefined();
    for (const executable of ["/bin/zsh", "/bin/node", "/bin/not-claude"]) {
      read.mockResolvedValue({ ...identity, executable });
      expect(await control.capture(identity.pid)).toBeUndefined();
    }
    read.mockResolvedValue({ ...identity, executable: "/bin/node", command: "node /lib/node_modules/@anthropic-ai/claude-code/cli.js" });
    expect(await control.capture(identity.pid)).toBeDefined();
    read.mockResolvedValue({ ...identity, executable: "/Users/test/.local/share/claude/versions/2.1.312" });
    expect(await control.capture(identity.pid)).toBeDefined();
  });

  it("does not signal a reused PID or a replaced session generation", async () => {
    const signal = vi.fn();
    const read = vi.fn(async () => ({ ...identity, started: "new-process" }));
    const control = new LocalClaudeProcessControl(read, signal);
    await expect(control.terminate(identity, () => true)).rejects.toThrow("进程身份已变化");
    read.mockResolvedValue(identity);
    await expect(control.terminate(identity, () => false)).rejects.toThrow("进程身份已变化");
    expect(signal).not.toHaveBeenCalled();
  });

  it("signals only the registered PID and waits until it exits", async () => {
    const read = vi.fn<() => Promise<ClaudeProcessIdentity | undefined>>().mockResolvedValueOnce(identity).mockResolvedValue(undefined);
    const signal = vi.fn();
    await new LocalClaudeProcessControl(read, signal).terminate(identity, () => true);
    expect(signal.mock.calls).toEqual([[identity.pid, "SIGTERM"]]);
  });

  it("reports a denied signal without pretending the process is closed", async () => {
    const control = new LocalClaudeProcessControl(async () => identity, () => { throw new Error("permission denied"); });
    await expect(control.terminate(identity, () => true)).rejects.toThrow("permission denied");
  });
});
