import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { findDshWebService, validateDshWebUrl } from "./dsh-web-service.js";
import { resolveStateDir } from "@orbis/e2e";
import { dshDesktopStateDirectory } from "./dsh-desktop-app.js";
import { isProcessChild, listeningPids, processCommand, processTable, processTree, sameProcess, stopOwnedProcesses, type ProcessIdentity } from "./owned-processes.js";

export type ShutdownRequest = { bridgePid: number; stateDir?: string; runtimeRoot: string; integrations: boolean; externalDsh: boolean };
type Descriptor = { path: string; text: string; root: ProcessIdentity; port: number };

async function descriptor(path: string): Promise<{ text: string; value: Record<string, unknown> } | undefined> {
  try { const text = await readFile(path, "utf8"); return { text, value: JSON.parse(text) as Record<string, unknown> }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("后台记录无法读取，请检查诊断后重试"); }
}

export function commandRunsScript(command: string, script: string, platform = process.platform): boolean {
  if (platform === "win32") { command = command.replaceAll("\\", "/").toLowerCase(); script = script.replaceAll("\\", "/").toLowerCase(); }
  const start = command.indexOf(script);
  return start >= 0 && (start === 0 || /[\s"']/u.test(command[start - 1]!))
    && (start + script.length === command.length || /[\s"']/u.test(command[start + script.length]!));
}

const identityKey = (row: ProcessIdentity): string => JSON.stringify([row.pid, row.started, row.executable]);
const executablePath = (path: string): string => process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;

/** HOST-EXIT-07: an independent Desktop is not owned just because Host launched it. Keep the
 * observed identity graph so a Desktop's already captured children remain protected after reparenting.
 * The local launch record is sufficient: a missing/starting backend must never authorize termination.
 */
export function preserveDshDesktop(stateDir: string, owned: Map<number, ProcessIdentity>, bridge?: ProcessIdentity, readCommand = processCommand) {
  const seen = new Map<string, ProcessIdentity>();
  const descendants = new Map<string, Set<string>>();
  const roots = new Set<string>();
  const commands = new Map<string, string>();
  return async (rows: ProcessIdentity[]): Promise<ProcessIdentity[]> => {
    const relevant = new Map<number, ProcessIdentity>();
    const current = new Map(rows.map(row => [row.pid, row]));
    // processTree retains the captured root object. Build new edges only from the current parent:
    // an old parent PID can now belong to an unrelated process, including a new Desktop instance.
    const remember = (row: ProcessIdentity) => { const now = current.get(row.pid); if (now && sameProcess(now, row)) relevant.set(row.pid, now); };
    for (const owner of owned.values()) for (const row of processTree(rows, owner)) remember(row);
    // Continue observing independent descendants after their original Host parent has exited.
    for (const key of roots) {
      const root = seen.get(key)!;
      for (const row of processTree(rows, root)) remember(row);
    }
    for (const row of relevant.values()) {
      const key = identityKey(row); seen.set(key, row);
      const parent = relevant.get(row.parent);
      if (parent && isProcessChild(parent, row)) {
        const parentKey = identityKey(parent);
        const children = descendants.get(parentKey) ?? new Set<string>(); children.add(key); descendants.set(parentKey, children);
      }
    }
    const stored = await descriptor(join(dshDesktopStateDirectory(stateDir), "endpoint.json"));
    if (stored) {
      const value = stored.value;
      if (!value || value.version !== 1 || value.owner !== "orbis" || !Number.isSafeInteger(value.pid) || Number(value.pid) < 0
        || typeof value.executable !== "string" || !isAbsolute(value.executable)) throw new Error("无法确认 DeepSeek 桌面版进程归属，请重试");
      const wanted = executablePath(value.executable);
      for (const [key, row] of seen) {
        if (bridge && sameProcess(bridge, row)) continue;
        let matches = executablePath(row.executable) === wanted;
        // Script fixtures/launchers have an interpreter as comm. Require the executable itself or
        // its first script argument, never a matching path elsewhere in unrelated command arguments.
        if (!matches && relevant.has(row.pid) && sameProcess(relevant.get(row.pid)!, row)) {
          let command = commands.get(key);
          if (command === undefined) { command = executablePath(await readCommand(row.pid)); commands.set(key, command); }
          const actualCommand = command;
          const forms = (path: string) => [path, `"${path}"`, `'${path}'`];
          const prefix = (text: string) => actualCommand === text || actualCommand.startsWith(text + " ");
          matches = forms(wanted).some(prefix) || forms(executablePath(row.executable)).some(executable => forms(wanted).some(script => prefix(`${executable} ${script}`)));
        }
        if (matches) roots.add(key);
      }
    }
    const protectedKeys = new Set(roots);
    for (const key of protectedKeys) for (const child of descendants.get(key) ?? []) protectedKeys.add(child);
    // Every protected descendant can acquire new children after its original root exits.
    for (const key of protectedKeys) roots.add(key);
    return [...protectedKeys].map(key => seen.get(key)!);
  };
}

/** Runs in a separate process so a wedged desktop command queue cannot block cleanup. */
export async function prepareDesktopShutdown(request: ShutdownRequest, parentPid = process.pid) {
  if (!Number.isSafeInteger(request.bridgePid) || request.bridgePid < 0 || !request.runtimeRoot) throw new Error("退出请求无效");
  const rows = await processTable();
  const owned = new Map<number, ProcessIdentity>();
  const descriptors: Descriptor[] = [];
  const observed = new Map<string, string | undefined>();
  const observe = async (path: string) => {
    const stored = await descriptor(path);
    observed.set(path, stored?.text);
    return stored;
  };
  const addTree = (root: ProcessIdentity) => { for (const row of processTree(rows, root)) owned.set(row.pid, row); };
  const bridge = rows.find(row => row.pid === request.bridgePid);
  if (bridge) {
    if (bridge.parent !== parentPid || !commandRunsScript(await processCommand(bridge.pid), join(request.runtimeRoot, "packages", "host", "dist", "desktop-bridge.js")))
      throw new Error("Host 核心进程身份已变化，请重试");
    addTree(bridge);
  }
  const preserve = preserveDshDesktop(resolveStateDir(request.stateDir?.trim() || process.env.ORBIS_HOST_STATE_DIR?.trim() || undefined), owned, bridge);
  await preserve(rows);
  const attachDescriptor = async (path: string, stored: { text: string }, root: ProcessIdentity, port: number) => {
    const tree = processTree(rows, root);
    const listeners = await listeningPids(port);
    if (!listeners.some(pid => tree.some(row => row.pid === pid))) throw new Error("无法确认后台端口归属，请关闭相关应用后重试");
    addTree(root); descriptors.push({ path, text: stored.text, root, port });
  };
  // HOST-EXIT-06: the Codex Desktop bridge belongs to Codex Desktop, which respawns it at once.
  // Stopping it only interrupts desktop tasks and races the respawn; the next Host attaches again.
  if (request.integrations && !request.externalDsh) {
    const configured = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
    const home = resolve(configured === "~" ? homedir() : /^~[/\\]/u.test(configured) ? join(homedir(), configured.slice(2)) : configured);
    const path = join(home, "cache", "orbis-web.json");
    const stored = await observe(path);
    if (stored) {
      const root = rows.find(row => row.pid === stored.value.pid);
      if (root) {
        const service = await findDshWebService({ ...process.env, DSH_HOME: home, ORBIS_DSH_WEB_URL: "" });
        if (!service) throw new Error("无法验证 DeepSeek Web 后台，请关闭该服务后重试");
        await attachDescriptor(path, stored, root, Number(new URL(service.url).port || "80"));
      } else if (typeof stored.value.url === "string") {
        const url = new URL(validateDshWebUrl(stored.value.url));
        if ((await listeningPids(Number(url.port || "80"))).length > 0)
          throw new Error("DeepSeek Web 记录已失效但端口仍被占用，请关闭该服务后重试");
      }
    }
  }
  return {
    async finish(graceMs = 10_000): Promise<void> {
      const deadline = Date.now() + graceMs;
      // Retain identities even after reparenting, and collect late children while their owner lives.
      do {
        const current = await processTable();
        const preserved = await preserve(current);
        for (const owner of [...owned.values()]) for (const row of processTree(current, owner, preserved)) owned.set(row.pid, row);
        if (!bridge || !current.some(row => sameProcess(row, bridge))) break;
        await delay(200);
      } while (Date.now() < deadline);
      await stopOwnedProcesses([...owned.values()], undefined, preserve);
      for (const entry of descriptors) {
        if ((await listeningPids(entry.port)).length > 0) throw new Error("后台端口仍被占用，请关闭相关应用后重试");
        // A replacement process may publish the same path while cleanup is running.
        if (await readFile(entry.path, "utf8").catch(() => "") === entry.text) await unlink(entry.path);
        else if (await descriptor(entry.path)) throw new Error("后台已重新启动，请关闭相关应用后重试");
      }
      // A command already in flight can publish a background after the initial snapshot.
      for (const [path, text] of observed) {
        const current = await descriptor(path);
        if (current && current.text !== text) throw new Error("后台已重新启动，请关闭相关应用后重试");
      }
    },
  };
}

async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  try {
    const first = await lines.next();
    if (first.done || first.value.length > 65_536) throw new Error("退出请求无效");
    const cleanup = await prepareDesktopShutdown(JSON.parse(first.value) as ShutdownRequest, process.ppid);
    process.stdout.write('{"event":"ready"}\n');
    const proceed = await lines.next();
    if (proceed.done || proceed.value !== "proceed") throw new Error("退出已取消");
    await cleanup.finish();
    process.stdout.write('{"event":"done"}\n');
  } finally { input.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never print argv, URLs or descriptor contents: they can contain local authentication tokens.
    process.stdout.write(JSON.stringify({ event: "error", message: error instanceof Error ? error.message : "后台收尾失败" }) + "\n");
    process.exitCode = 1;
  });
}
