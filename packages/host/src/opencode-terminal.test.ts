import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runOpenCodeTerminalHandoff } from "./opencode-local-launch.js";
import { OPENCODE_CLIENT_VERSION } from "./opencode-service-connection.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

// OPENCODE-TUI-01: exercise the actual SDK against an isolated registration with synthetic auth.
it("rechecks the service and exact session before spawning the native CLI, passing auth only in its environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbis-opencode 工作区's "));
  const registration = join(directory, "opencode", "service.json");
  const password = "synthetic-registration-password";
  const sessionId = "ses_handoff-test";
  const pin = { pid: process.pid, version: OPENCODE_CLIENT_VERSION };
  const current = { id: sessionId, location: { directory }, time: { updated: 2 } };
  let info: typeof pin = pin;
  let session: object | undefined = current;
  let redirect = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      res.writeHead(401).end();
    } else if (req.url === "/api/info") {
      if (redirect) res.writeHead(302, { location: "/must-not-follow" }).end();
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info));
    } else if (req.url?.endsWith(`/${sessionId}`) && session) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: session }));
    } else res.writeHead(404).end();
  });
  const native = vi.mocked(spawn);
  native.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child as ReturnType<typeof spawn>;
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback bind failed");
    const origin = `http://127.0.0.1:${address.port}`;
    const registered = { url: origin, id: "fixture-registration-id", ...pin, password };
    await mkdir(join(directory, "opencode"));
    await writeFile(registration, JSON.stringify(registered), { mode: 0o600 });
    vi.stubEnv("XDG_STATE_HOME", directory);
    vi.stubEnv("OPENCODE_PASSWORD", "incorrect-ambient-password");
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "ignored-server-password");
    vi.stubEnv("OPENAI_API_KEY", "ignored-provider-key");
    vi.stubEnv("OPENCODE_PTY_HANDOFF", "ignored-pty-handoff");
    const root = await realpath(directory);
    const workspace = join(root, "workspace");
    const alias = join(root, "old-path");
    const replacement = join(root, "different-workspace");
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    current.location.directory = alias;
    const target = { sessionId, directory: alias, workspace, service: { origin, pid: pin.pid, registrationId: registered.id } };
    const handoff = Buffer.from(JSON.stringify({ target, cliCommand: { command: process.execPath, prefixArgs: ["fixture-cli.js"] } })).toString("base64url");
    await expect(runOpenCodeTerminalHandoff(handoff)).resolves.toBe(0);
    expect(native).toHaveBeenCalledExactlyOnceWith(process.execPath, ["fixture-cli.js", workspace, "--session", sessionId, "--server", origin],
      { cwd: workspace, stdio: "inherit", env: expect.objectContaining({ OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: "1", XDG_STATE_HOME: directory }) });
    const env = native.mock.calls[0]?.[2]?.env;
    for (const key of ["OPENCODE_SERVER_PASSWORD", "OPENAI_API_KEY", "OPENCODE_PTY_HANDOFF"]) expect(env).not.toHaveProperty(key);
    expect(requests).toEqual(["GET /api/info", `GET /api/session/${sessionId}`]);
    native.mockClear();

    for (const staleSession of [undefined, { ...current, id: "different-id" }, { ...current, location: { directory: join(directory, "other") } },
      { ...current, time: { archived: 3 } }, { ...current, parentID: "parent-session" }]) {
      session = staleSession;
      await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("无法恢复原 OpenCode 会话");
    }
    session = current;
    for (const staleService of [{ ...pin, pid: pin.pid + 1 }, { ...pin, version: "2.3.1" }]) {
      info = staleService;
      await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("共享服务已断开或更换");
    }
    redirect = true;
    await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("共享服务已断开或更换");
    expect(requests).not.toContain("GET /must-not-follow");
    const count = requests.length;
    for (const changed of [{ ...registered, id: "replacement" }, { ...registered, url: "http://192.0.2.10:4096" }]) {
      await writeFile(registration, JSON.stringify(changed));
      await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("共享服务已断开或更换");
    }
    await unlink(registration);
    await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("共享服务已断开或更换");
    await mkdir(replacement);
    await (process.platform === "win32" ? rm(alias) : unlink(alias));
    await symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(runOpenCodeTerminalHandoff(handoff)).rejects.toThrow("工作区已变化或不可用");
    expect(requests).toHaveLength(count);
    expect(native).not.toHaveBeenCalled();
    expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
