import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRunsScript, prepareDesktopShutdown, preserveDshDesktop } from "./desktop-shutdown.js";
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
const dshCli = { command: process.execPath, prefixArgs: ["-e", `const http=require('node:http'); const s=http.createServer((q,r)=>{if(q.url==='/?token=test-shutdown-service-token'){r.writeHead(303,{'set-cookie':'dsh-auth-test=yes'});r.end()}else if(q.headers.cookie==='dsh-auth-test=yes'){r.end('__DSH_BOOT__')}else{r.writeHead(401);r.end()}});s.listen(0,'127.0.0.1',()=>console.log('dsh web: http://127.0.0.1:'+s.address().port+'/?token=test-shutdown-service-token'));`, "--"] };
/** Starts an authenticated Orbis-owned DSH Web service and returns its recorded descriptor. */
async function dshService() {
  const service = await ensureDshWebService({ ...process.env, ORBIS_DSH_WEB_URL: "" }, { cli: dshCli, port: 0 });
  const path = join(process.env.DSH_HOME!, "cache", "orbis-web.json");
  const text = await readFile(path, "utf8"); const pid = (JSON.parse(text) as { pid: number }).pid; pids.push(pid);
  return { service, path, text, pid };
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

  // HOST-EXIT-07: detached Desktop remains a bridge descendant until the bridge exits. Its root
  // and backend survive all cleanup snapshots, including a PID-less launch intent and a late record.
  it.each(["recorded", "late-record", "launch-intent"] as const)("preserves independent Desktop and its backend during confirmed exit (%s)", async mode => {
    const f = await fixture();
    const desktop = join(f.root, "desktop.js");
    await writeFile(desktop, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();console.log(child.pid);setInterval(()=>{},1000);`);
    const bridge = await start(f.root, `const {spawn}=require('node:child_process');const desktop=spawn(process.execPath,[${JSON.stringify(desktop)}],{detached:true,stdio:['ignore','pipe','ignore']});desktop.stdout.once('data',data=>{console.log(JSON.stringify({desktop:desktop.pid,backend:Number(String(data))}));desktop.stdout.destroy();desktop.unref()});setInterval(()=>{},1000);`);
    const ids = JSON.parse(String((await once(bridge.stdout!, "data"))[0])) as { desktop: number; backend: number }; pids.push(ids.desktop, ids.backend);
    const path = join(f.stateDir, "dsh-desktop", "endpoint.json"); await mkdir(join(path, ".."), { recursive: true });
    const stored = JSON.stringify({ version: 1, owner: "orbis", pid: mode === "launch-intent" ? 0 : ids.desktop, executable: desktop,
      archive: join(f.root, "app.asar"), logPath: join(f.root, "desktop.log"), launchedAt: Date.now() });
    if (mode !== "late-record") await writeFile(path, stored);
    const cleanup = await prepareDesktopShutdown({ ...f.request, bridgePid: bridge.pid! });
    if (mode === "late-record") await writeFile(path, stored);
    await cleanup.finish(0);
    const rows = await processTable();
    expect(rows.some(row => row.pid === bridge.pid)).toBe(false);
    expect(rows.some(row => row.pid === ids.desktop)).toBe(true);
    expect(rows.some(row => row.pid === ids.backend)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(stored);
  }, 30_000);

  // Protect observed descendants by their captured identity after Desktop itself exits. A stale
  // PID or a matching pathname used as an unrelated argument must not exempt a real Host backend.
  it("retains a protected reparented backend without protecting an unrelated argument match", async () => {
    const f = await fixture(); const desktop = join(f.root, "desktop.js");
    await writeFile(desktop, `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();console.log(child.pid);setInterval(()=>{},1000);`);
    const bridge = await start(f.root, `const {spawn}=require('node:child_process');const desktop=spawn(process.execPath,[${JSON.stringify(desktop)}],{detached:true,stdio:['ignore','pipe','ignore']});const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)',${JSON.stringify(desktop)}],{stdio:'ignore'});desktop.stdout.once('data',data=>{console.log(JSON.stringify({desktop:desktop.pid,backend:Number(String(data)),other:other.pid}));desktop.stdout.destroy();desktop.unref()});setInterval(()=>{},1000);`);
    const ids = JSON.parse(String((await once(bridge.stdout!, "data"))[0])) as { desktop: number; backend: number; other: number }; pids.push(ids.desktop, ids.backend, ids.other);
    const path = join(f.stateDir, "dsh-desktop", "endpoint.json"); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, owner: "orbis", pid: ids.desktop, executable: desktop }));
    const cleanup = await prepareDesktopShutdown({ ...f.request, bridgePid: bridge.pid! });
    process.kill(ids.desktop, "SIGTERM");
    await vi.waitFor(async () => expect((await processTable()).some(row => row.pid === ids.desktop)).toBe(false));
    await cleanup.finish(0);
    const rows = await processTable();
    expect(rows.some(row => row.pid === ids.backend)).toBe(true);
    expect(rows.some(row => row.pid === ids.other || row.pid === bridge.pid)).toBe(false);
  }, 30_000);

  it("refuses an unreadable independent Desktop record before terminating its bridge", async () => {
    const f = await fixture(); const bridge = await start(f.root, "setInterval(()=>{},1000)");
    const path = join(f.stateDir, "dsh-desktop", "endpoint.json"); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{broken");
    await expect(prepareDesktopShutdown({ ...f.request, bridgePid: bridge.pid! })).rejects.toThrow("记录无法读取");
    expect((await processTable()).some(row => row.pid === bridge.pid)).toBe(true);
  });

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
    const { service, path, pid } = await dshService(); const old = { pid };
    await writeFile(join(home, "history.jsonl"), "keep history");
    // An explicit external endpoint must be preserved, even if an Orbis-owned descriptor also exists.
    await (await prepareDesktopShutdown({ ...f.request, integrations: true, externalDsh: true })).finish(0);
    expect((await fetch(service.url, { redirect: "manual" })).status).toBe(303);
    await (await prepareDesktopShutdown({ ...f.request, integrations: true })).finish(0);
    expect((await processTable()).some(row => row.pid === old.pid)).toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "history.jsonl"), "utf8")).toBe("keep history");
  }, 30_000);

  // HOST-EXIT-06: Codex Desktop respawns its bridge as soon as it dies. Exit must neither stop it
  // nor treat Codex Desktop's replacement record as a failed cleanup.
  it("leaves the Codex Desktop bridge running even when Codex Desktop replaces it during cleanup", async () => {
    const f = await fixture();
    const listener = `const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));`;
    const original = await start(f.root, listener, "codex-desktop-wrapper.js");
    const port = Number(String((await once(original.stdout!, "data"))[0]).trim());
    const path = join(f.stateDir, "codex-desktop-endpoint.json");
    await writeFile(path, JSON.stringify({ schema: 1, bridgePid: original.pid, url: `ws://127.0.0.1:${port}` }));
    const cleanup = await prepareDesktopShutdown({ ...f.request, integrations: true });
    const respawned = await start(f.root, listener, "codex-desktop-wrapper.js");
    const respawnedPort = Number(String((await once(respawned.stdout!, "data"))[0]).trim());
    const replacement = JSON.stringify({ schema: 1, bridgePid: respawned.pid, url: `ws://127.0.0.1:${respawnedPort}` });
    await writeFile(path, replacement);
    await cleanup.finish(0);
    const rows = await processTable();
    expect(rows.some(row => row.pid === original.pid)).toBe(true);
    expect(rows.some(row => row.pid === respawned.pid)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(replacement);
  }, 20_000);

  // A valid-looking service record is not sufficient evidence to terminate its PID.
  it("refuses a DSH record whose PID does not own the authenticated listener", async () => {
    const f = await fixture();
    const { path, text, pid } = await dshService();
    const unrelated = await start(f.root, "setInterval(()=>{},1000)", "unrelated.js");
    await writeFile(path, JSON.stringify({ ...JSON.parse(text) as object, pid: unrelated.pid }));
    await expect(prepareDesktopShutdown({ ...f.request, integrations: true })).rejects.toThrow("端口归属");
    const rows = await processTable(); expect(rows.some(row => row.pid === unrelated.pid)).toBe(true); expect(rows.some(row => row.pid === pid)).toBe(true);
  }, 30_000);

  // A dead recorded launcher cannot justify ignoring a surviving listener or killing its new owner.
  it("blocks installation when a stale DSH PID still points at a live port", async () => {
    const f = await fixture();
    const listener = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "listener.js");
    const port = Number(String((await once(listener.stdout!, "data"))[0]).trim());
    const path = join(process.env.DSH_HOME!, "cache", "orbis-web.json");
    await mkdir(join(path, ".."), { recursive: true });
    const stored = { version: 1, owner: "orbis", pid: 2147483647, url: `http://127.0.0.1:${port}/?token=test-shutdown-service-token` };
    await writeFile(path, JSON.stringify(stored));
    await expect(prepareDesktopShutdown({ ...f.request, integrations: true })).rejects.toThrow("端口仍被占用");
    expect((await processTable()).some(row => row.pid === listener.pid)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(stored);
  }, 20_000);

  // A newly published generation must survive and force the installer to pause.
  it("detects a DSH service first registered after the cleanup snapshot", async () => {
    const f = await fixture();
    const cleanup = await prepareDesktopShutdown({ ...f.request, integrations: true });
    const listener = await start(f.root, "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));", "listener.js");
    const port = Number(String((await once(listener.stdout!, "data"))[0]).trim());
    const path = join(process.env.DSH_HOME!, "cache", "orbis-web.json");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, owner: "orbis", pid: listener.pid, url: `http://127.0.0.1:${port}/?token=test-shutdown-service-token` }));
    await expect(cleanup.finish(0)).rejects.toThrow("重新启动");
    expect((await processTable()).some(row => row.pid === listener.pid)).toBe(true);
    expect(await readFile(path, "utf8")).toContain(String(listener.pid));
  }, 20_000);

  // An existing record replaced during cleanup must also be preserved.
  it("reports a replacement DSH record instead of deleting it or allowing installation", async () => {
    const f = await fixture();
    const { path } = await dshService();
    const cleanup = await prepareDesktopShutdown({ ...f.request, integrations: true });
    const replacement = JSON.stringify({ version: 1, owner: "orbis", pid: 424242, url: "http://127.0.0.1:12345/?token=test-shutdown-service-token" });
    await writeFile(path, replacement);
    await expect(cleanup.finish(0)).rejects.toThrow("重新启动");
    expect(await readFile(path, "utf8")).toBe(replacement);
  }, 30_000);
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

  // Windows preserves a child's original ParentProcessId after exit. CreationDate ticks must
  // reject a replacement parent born later than that child, while admitting its genuine children.
  it("does not adopt or stop an older Windows orphan whose parent PID was reused", async () => {
    const parent = { ...owner, started: "638987000000000002" };
    const orphan = { ...owner, pid: 424243, parent: parent.pid, started: "638987000000000001" };
    const child = { ...owner, pid: 424244, parent: parent.pid, started: "638987000000000003" };
    let rows = [parent, orphan, child];
    expect(processTree(rows, parent)).toEqual([parent, child]);
    const signal = vi.fn((pid: number) => { rows = rows.filter(row => row.pid !== pid); });
    await stopOwnedProcesses([parent], { table: async () => rows, signal, wait: async () => {} });
    expect(signal.mock.calls).toEqual([[parent.pid, "SIGTERM"], [child.pid, "SIGTERM"]]);
    expect(rows).toEqual([orphan]);
  });
  it("reports failure when an owned process remains after escalation", async () => {
    const signal = vi.fn();
    await expect(stopOwnedProcesses([owner], { table: async () => [owner], signal, wait: async () => {} })).rejects.toThrow("尚未退出");
    expect(signal.mock.calls).toEqual([[owner.pid, "SIGTERM"], [owner.pid, "SIGKILL"]]);
  });

  // HOST-EXIT-07: protection can appear only after the first tree expansion. Every signal and
  // escalation must re-evaluate it; protected processes do not count as unfinished cleanup.
  it("rechecks late independent-process protection before signalling an already captured child", async () => {
    const desktop = { ...owner, pid: 424243, parent: owner.pid, executable: "/independent/Desktop" };
    const backend = { ...owner, pid: 424244, parent: desktop.pid };
    let rows = [owner, desktop, backend]; let scans = 0;
    const signal = vi.fn((pid: number) => { rows = rows.filter(row => row.pid !== pid); });
    await stopOwnedProcesses([owner], { table: async () => rows, signal, wait: async () => {} }, async () => ++scans < 3 ? [] : [desktop, backend]);
    expect(signal.mock.calls).toEqual([[owner.pid, "SIGTERM"]]);
    expect(rows).toEqual([desktop, backend]);
  });

  it("rechecks process identity after asynchronous protection lookup before sending a signal", async () => {
    const replacement = { ...owner, started: "replacement-during-protection" };
    let rows = [owner]; let scans = 0; const signal = vi.fn();
    await stopOwnedProcesses([owner], { table: async () => rows, signal, wait: async () => {} }, async () => {
      if (++scans === 2) rows = [replacement];
      return [];
    });
    expect(signal).not.toHaveBeenCalled();
  });

  // HOST-EXIT-07: remember real historical edges, but never attach an orphan's cached parent PID
  // to a replacement process. Otherwise an unrelated Desktop can exempt a genuine Host worker.
  it.each(["unix", "windows"] as const)("does not connect an orphaned Host worker to a Desktop that reused its old parent's PID (%s)", async platform => {
    const f = await fixture();
    const bridge = { ...owner, pid: 424240, parent: 1, started: "638987000000000000" };
    const original = { ...owner, pid: 424241, parent: bridge.pid, started: "638987000000000001" };
    const worker = { ...owner, pid: 424242, parent: original.pid, started: "638987000000000002", executable: "/owned/worker" };
    const owned = new Map([bridge, original, worker].map(row => [row.pid, row]));
    const preserve = preserveDshDesktop(f.stateDir, owned, bridge, async () => "");
    expect(await preserve([bridge, original, worker])).toEqual([]);
    const desktop = { ...original, started: "638987000000000003", executable: "/independent/Desktop" };
    const orphan = { ...worker, parent: platform === "windows" ? original.pid : 1 };
    const path = join(f.stateDir, "dsh-desktop", "endpoint.json"); await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, owner: "orbis", pid: desktop.pid, executable: desktop.executable }));
    const preserved = await preserve([bridge, desktop, orphan]);
    expect(preserved).toEqual([desktop]);
    expect(preserved.some(row => sameProcess(row, worker))).toBe(false);
  });
});
