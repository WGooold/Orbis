import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRunsScript, prepareDesktopShutdown } from "./desktop-shutdown.js";
import { processTable, processTree, sameProcess, stopOwnedProcesses, type ProcessIdentity } from "./owned-processes.js";
import { ensureDshWebService } from "./dsh-web-service.js";

const roots: string[] = []; const children: ChildProcess[] = []; const pids: number[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped by the assertion. */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-shutdown-")); roots.push(root);
  const stateDir = join(root, "state"); await mkdir(stateDir);
  vi.stubEnv("DSH_HOME", join(root, "dsh")); vi.stubEnv("ORBIS_CODEX_WRAPPER_ROOT", join(root, "wrapper"));
  return { root, stateDir, request: { runtimeRoot: root, stateDir, bridgePid: 0, integrations: false, externalDsh: false } };
}
async function start(root: string, script: string, name = "desktop-bridge.js") {
  const path = join(root, "packages", "host", "dist", name); await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, script);
  const child = spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  await once(child, "spawn");
  return child;
}

describe("confirmed desktop shutdown", () => {
  // HOST-EXIT-01: snapshot does not mutate processes; cancellation must leave the tree untouched.
  it("captures a real owned bridge without stopping it until confirmation proceeds", async () => {
    const f = await fixture(); const child = await start(f.root, "setInterval(() => {}, 1000)");
    const cleanup = await prepareDesktopShutdown({ ...f.request, bridgePid: child.pid! });
    expect((await processTable()).some(row => row.pid === child.pid)).toBe(true);
    await cleanup.finish(0);
    expect((await processTable()).some(row => row.pid === child.pid)).toBe(false);
  }, 20_000);

  // HOST-EXIT-02: a wedged parent and its detached child must both disappear; a sibling survives.
  it("reaps a stubborn bridge and its detached descendant without touching another process", async () => {
    const f = await fixture();
    const child = await start(f.root, `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); console.log(child.pid); process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const descendant = Number(String((await once(child.stdout!, "data"))[0]).trim()); pids.push(descendant);
    const sibling = await start(f.root, "setInterval(() => {}, 1000)", "sibling.js");
    const cleanup = await prepareDesktopShutdown({ ...f.request, bridgePid: child.pid! });
    await cleanup.finish(0);
    const rows = await processTable();
    expect(rows.some(row => row.pid === child.pid || row.pid === descendant)).toBe(false);
    expect(rows.some(row => row.pid === sibling.pid)).toBe(true);
  }, 30_000);

  it("refuses a recycled bridge PID whose command is unrelated", async () => {
    const f = await fixture(); const child = await start(f.root, "setInterval(() => {}, 1000)", "unrelated.js");
    await expect(prepareDesktopShutdown({ ...f.request, bridgePid: child.pid! })).rejects.toThrow("身份已变化");
    expect((await processTable()).some(row => row.pid === child.pid)).toBe(true);
  });
  it("does not adopt another Host with the same executable and script", async () => {
    const f = await fixture(); const child = await start(f.root, "setInterval(() => {}, 1000)");
    await expect(prepareDesktopShutdown({ ...f.request, bridgePid: child.pid! }, 424242)).rejects.toThrow("身份已变化");
    expect((await processTable()).some(row => row.pid === child.pid)).toBe(true);
  });

  // HOST-EXIT-03: legacy version-1 DSH descriptors are accepted only after auth + listener ownership.
  it("closes a previously detached DSH service and retains its data", async () => {
    const f = await fixture(); const home = process.env.DSH_HOME!;
    const cli = { command: process.execPath, prefixArgs: ["-e", `const http=require('node:http'); const s=http.createServer((q,r)=>{if(q.url==='/?token=test-shutdown-service-token'){r.writeHead(303,{'set-cookie':'dsh-auth-test=yes'});r.end()}else if(q.headers.cookie==='dsh-auth-test=yes'){r.end('__DSH_BOOT__')}else{r.writeHead(401);r.end()}});s.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+s.address().port+'/?token=test-shutdown-service-token'));`, "--"] };
    const service = await ensureDshWebService({ ...process.env, ORBIS_DSH_WEB_URL: "" }, { cli, port: 0 });
    const path = join(home, "cache", "orbis-web.json"); const old = JSON.parse(await readFile(path, "utf8")) as { pid: number }; pids.push(old.pid);
    await writeFile(join(home, "history.jsonl"), "keep history");
    // An explicit external endpoint must be preserved, even if an Orbis-owned descriptor also exists.
    await (await prepareDesktopShutdown({ ...f.request, integrations: true, externalDsh: true })).finish(0);
    expect((await fetch(service.url, { redirect: "manual" })).status).toBe(303);
    await (await prepareDesktopShutdown({ ...f.request, integrations: true })).finish(0);
    expect((await processTable()).some(row => row.pid === old.pid)).toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "history.jsonl"), "utf8")).toBe("keep history");
  }, 30_000);

  it("closes only a verified Codex wrapper and its listening child", async () => {
    const f = await fixture();
    const child = await start(f.root, `const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`, "codex-desktop-wrapper.js");
    const port = Number(String((await once(child.stdout!, "data"))[0]).trim());
    const path = join(f.stateDir, "codex-desktop-endpoint.json");
    await writeFile(path, JSON.stringify({ schema: 1, bridgePid: child.pid, url: `ws://127.0.0.1:${port}` }));
    await (await prepareDesktopShutdown({ ...f.request, integrations: true })).finish(0);
    expect((await processTable()).some(row => row.pid === child.pid)).toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  // A valid-looking endpoint file is not sufficient evidence to terminate its PID.
  it("refuses a descriptor pointing at another process's listener", async () => {
    const f = await fixture();
    const root = await start(f.root, "setInterval(()=>{},1000)", "codex-desktop-wrapper.js");
    const listener = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "listener.js");
    const port = Number(String((await once(listener.stdout!, "data"))[0]).trim());
    await writeFile(join(f.stateDir, "codex-desktop-endpoint.json"), JSON.stringify({ schema: 1, bridgePid: root.pid, url: `ws://127.0.0.1:${port}` }));
    await expect(prepareDesktopShutdown({ ...f.request, integrations: true })).rejects.toThrow("端口归属");
    const rows = await processTable(); expect(rows.some(row => row.pid === root.pid)).toBe(true); expect(rows.some(row => row.pid === listener.pid)).toBe(true);
  }, 20_000);

  // A dead recorded launcher cannot justify ignoring a surviving listener or killing its new owner.
  it.each(["codex", "dsh"])("blocks installation when a stale %s PID still points at a live port", async kind => {
    const f = await fixture();
    const listener = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "listener.js");
    const port = Number(String((await once(listener.stdout!, "data"))[0]).trim());
    const path = kind === "codex" ? join(f.stateDir, "codex-desktop-endpoint.json") : join(process.env.DSH_HOME!, "cache", "orbis-web.json");
    await mkdir(join(path, ".."), { recursive: true });
    const stored = kind === "codex" ? { schema: 1, bridgePid: 2147483647, url: `ws://127.0.0.1:${port}` }
      : { version: 1, owner: "orbis", pid: 2147483647, url: `http://127.0.0.1:${port}/?token=test-shutdown-service-token` };
    await writeFile(path, JSON.stringify(stored));
    await expect(prepareDesktopShutdown({ ...f.request, integrations: true })).rejects.toThrow("端口仍被占用");
    expect((await processTable()).some(row => row.pid === listener.pid)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stored);
  }, 20_000);

  // A newly published generation must survive and force the installer to pause.
  it("detects a background first registered after the cleanup snapshot", async () => {
    const f = await fixture();
    const cleanup = await prepareDesktopShutdown({ ...f.request, integrations: true });
    const listener = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "codex-desktop-wrapper.js");
    const port = Number(String((await once(listener.stdout!, "data"))[0]).trim());
    const path = join(f.stateDir, "codex-desktop-endpoint.json");
    await writeFile(path, JSON.stringify({ schema: 1, bridgePid: listener.pid, url: `ws://127.0.0.1:${port}` }));
    await expect(cleanup.finish(0)).rejects.toThrow("重新启动");
    expect((await processTable()).some(row => row.pid === listener.pid)).toBe(true);
    expect(await readFile(path, "utf8")).toContain(String(listener.pid));
  }, 20_000);

  // An existing descriptor replaced during cleanup must also be preserved.
  it("reports a replacement descriptor instead of deleting it or allowing installation", async () => {
    const f = await fixture();
    const root = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "codex-desktop-wrapper.js");
    const port = Number(String((await once(root.stdout!, "data"))[0]).trim());
    const path = join(f.stateDir, "codex-desktop-endpoint.json");
    await writeFile(path, JSON.stringify({ schema: 1, bridgePid: root.pid, url: `ws://127.0.0.1:${port}` }));
    const cleanup = await prepareDesktopShutdown({ ...f.request, integrations: true });
    const replacement = JSON.stringify({ schema: 1, bridgePid: 424242, url: "ws://127.0.0.1:12345" });
    await writeFile(path, replacement);
    await expect(cleanup.finish(0)).rejects.toThrow("重新启动");
    expect(await readFile(path, "utf8")).toBe(replacement);
  }, 20_000);
});

describe("process identity protection", () => {
  const owner: ProcessIdentity = { pid: 424242, parent: 123, started: "original", executable: "/owned/node" };
  // Qt sends forward-slash paths on Windows; native command lines may report backslashes and different drive casing.
  it("recognizes Windows path spelling without accepting a path prefix or another script", () => {
    expect(commandRunsScript('"C:\\Orbis Tools\\node.exe" "c:/Orbis Tools/desktop-bridge.js"', 'C:\\Orbis Tools\\desktop-bridge.js', "win32")).toBe(true);
    expect(commandRunsScript('node "C:/Orbis/desktop-bridge.js.extra"', 'C:\\Orbis\\desktop-bridge.js', "win32")).toBe(false);
    expect(commandRunsScript('node "C:/Other/Orbis/desktop-bridge.js"', 'C:\\Orbis\\desktop-bridge.js', "win32")).toBe(false);
  });
  // HOST-EXIT-04: PID reuse must never transfer permission to the new process or its children.
  it("does not signal a replacement PID or adopt its descendants", async () => {
    const replacement = { ...owner, started: "replacement" };
    const rows = [replacement, { ...owner, pid: 424243, parent: owner.pid }];
    expect(sameProcess(owner, replacement)).toBe(false); expect(processTree(rows, owner)).toEqual([]);
    const signal = vi.fn();
    await stopOwnedProcesses([owner], { table: async () => rows, signal, wait: async () => {} });
    expect(signal).not.toHaveBeenCalled();
  });
  it("reports failure when an owned process remains after escalation", async () => {
    const signal = vi.fn();
    await expect(stopOwnedProcesses([owner], { table: async () => [owner], signal, wait: async () => {} })).rejects.toThrow("尚未退出");
    expect(signal.mock.calls).toEqual([[owner.pid, "SIGTERM"], [owner.pid, "SIGKILL"]]);
  });
});
