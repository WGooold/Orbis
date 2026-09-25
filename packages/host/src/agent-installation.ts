import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AgentKind } from "@pi-remote/protocol";
import { agentKind } from "./provider-manager.js";
import { DSH_VERSION } from "./dsh-client.js";

const execute = promisify(execFile);
export const agentPackages = { pi: "@earendil-works/pi-coding-agent", codex: "@openai/codex", dsh: "@deepseek-ai/dsh" } as const;
export const agentEntries = { pi: "dist/bundle/cli.js", codex: "bin/codex.js", dsh: "lib/bin.js" } as const;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export type AgentInstallation = { id: string; kind: AgentKind; version: string; entry: string; installedAt: string; active: boolean };
export type AgentInstallProgress = { kind: AgentKind; stage: "resolving" | "downloading" | "verifying" | "activating" | "done" | "cancelled" | "error"; version?: string; message?: string };
export type LocalAgent = { installed: boolean; installedButBroken: boolean; version?: string; entry?: string; error?: string };
export type AgentInstallStatus = LocalAgent & {
  kind: AgentKind; package: string; latestVersion?: string; recommendedVersion?: string; compatibilityNote?: string; updateAvailable: boolean; latestError?: string;
  installationSource: "managed" | "npm" | "custom" | "unknown";
  installations: AgentInstallation[]; copies: { entry: string; version?: string }[];
};
export type InstallRun = (command: string, args: string[], options: { signal: AbortSignal; timeout: number; cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export function parseAgentVersion(value: string): { core: bigint[]; pre: string[] } | undefined {
  const match = versionPattern.exec(value.trim());
  if (!match || match[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return undefined;
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], pre: match[4]?.split(".") ?? [] };
}
export function compareAgentVersions(left: string, right: string): number | undefined {
  const a = parseAgentVersion(left); const b = parseAgentVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]; const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
export function extractAgentVersion(output: string): string | undefined {
  return output.match(/(?:^|[\s(])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=[\s)]|$)/m)?.[1];
}
export function recommendedAgentVersion(kind: AgentKind, latest?: string): string | undefined {
  return kind === "dsh" && (!latest || compareAgentVersions(latest, DSH_VERSION) === -1) ? DSH_VERSION : latest;
}
export function installPackage(kind: string, version: string): string {
  const selected = agentKind(kind);
  if (version !== version.trim() || version !== "latest" && !parseAgentVersion(version)) throw new Error("版本应为 latest 或完整版本号，例如 0.1.7-rc.1");
  return `${agentPackages[selected]}@${version}`;
}
function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
function registryPath(root: string, kind: AgentKind): string { return join(root, kind, "installations.json"); }

export async function listManagedAgentInstallations(kind: AgentKind, root: string): Promise<AgentInstallation[]> {
  try {
    const data = JSON.parse(await readFile(registryPath(root, kind), "utf8")) as { version: number; installations: AgentInstallation[] };
    if (data.version !== 1 || !Array.isArray(data.installations) || data.installations.some(item => !item || item.kind !== kind || typeof item.id !== "string" || !/^[\w-]+$/.test(item.id) || typeof item.version !== "string" || !parseAgentVersion(item.version) || typeof item.entry !== "string" || !within(join(root, kind, item.id), item.entry) || typeof item.installedAt !== "string" || typeof item.active !== "boolean") || data.installations.filter(item => item.active).length > 1) throw new Error("invalid manifest");
    return data.installations;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error("Agent 安装记录不可读，请检查文件权限和 installations.json");
  }
}
async function saveInstallations(root: string, kind: AgentKind, installations: AgentInstallation[]): Promise<void> {
  const path = registryPath(root, kind); const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, installations }, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function activeManagedEntry(kind: AgentKind, root: string): Promise<string | undefined> {
  return (await listManagedAgentInstallations(kind, root)).find(item => item.active)?.entry;
}
export function installationSource(entry: string | undefined, root: string): AgentInstallStatus["installationSource"] {
  if (!entry) return "unknown";
  if (within(root, entry)) return "managed";
  const normalized = entry.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/node_modules/") && !/\/(\.pnpm|pnpm|\.volta|volta|\.bun)\//.test(normalized)) return "npm";
  return "custom";
}

/** Never invoke npm.cmd via PATH. Pin npm and its Node interpreter to one installation. */
export async function resolveNpmTool(prefix?: string): Promise<{ command: string; args: string[] }> {
  const node = prefix && await exists(join(prefix, "node.exe")) ? join(prefix, "node.exe") : process.execPath;
  const adjacent = join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  if (!await exists(adjacent)) throw new Error("缺少当前 Node 对应的 npm，请修复 Orbis Host 安装");
  return { command: node, args: [adjacent] };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

/** Wait for close, including child pipes, after killing only this operation's process tree. */
export const runAgentInstaller: InstallRun = async (command, args, options) => {
  options.signal.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, PATH: dirname(command) + delimiter + (process.env.PATH ?? process.env.Path ?? "") };
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}), detached: process.platform !== "win32" });
    let stdout = ""; let stderr = ""; let stopped: Error | undefined; let terminating: Promise<unknown> | undefined;
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      if (!child.pid) return;
      if (process.platform === "win32") {
        terminating = execute(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }).catch(() => { child.kill(); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const abort = () => stop(new Error("安装已取消"));
    const timer = setTimeout(() => stop(new Error("Agent 安装超时")), options.timeout);
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(-64_000); });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-64_000); });
    child.on("error", error => { stopped ??= error; });
    child.on("close", code => {
      clearTimeout(timer); options.signal.removeEventListener("abort", abort);
      void Promise.resolve(terminating).then(() => {
        if (stopped) reject(stopped);
        else if (code !== 0) reject(Object.assign(new Error("npm/CLI exited"), { stderr, stdout, code }));
        else resolveRun({ stdout, stderr });
      });
    });
    if (options.signal.aborted) abort();
  });
};

function failureMessage(error: unknown): string {
  // Inspect diagnostics only for classification; registry tokens/proxy passwords never leave this module.
  const value = error as { message?: string; stderr?: string; code?: string };
  const detail = [value?.message, value?.stderr, value?.code].join(" ");
  if (/EINTEGRITY/i.test(detail)) return "下载包完整性校验失败，请重试或检查 npm 缓存";
  if (/E404|ETARGET/i.test(detail)) return "npm 中没有该版本，请检查版本号";
  if (/EACCES|EPERM|EBUSY/i.test(detail)) return "安装目录无写入权限或文件被占用，请关闭使用该 Agent 的终端后重试";
  if (/ENOSPC/i.test(detail)) return "磁盘空间不足";
  if (/EBADENGINE/i.test(detail)) return "此 Agent 版本需要更新的 Node.js，请更新 Host";
  if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|CERT|网络|fetch/i.test(detail)) return "下载失败，请检查网络、代理和 npm 源";
  if (/^(安装包名称或版本不匹配|缺少 CLI 入口|CLI 入口格式不受支持|Agent 实际运行版本与安装包版本不一致|Agent 安装超时|缺少当前 Node 对应的 npm，请修复 Orbis Host 安装|该入口不属于 npm 安装，请选择 Orbis 独立安装|无法确定原安装位置，请选择 Orbis 独立安装|此入口属于项目依赖，请在项目中更新或选择 Orbis 独立安装|Agent 安装记录不可读，请检查文件权限和 installations.json)$/.test(value?.message ?? "")) return value.message!;
  return "Agent 下载或验证失败，请检查网络、npm 源和版本号";
}

async function verifyPackage(kind: AgentKind, prefix: string, requested: string, signal: AbortSignal, run: InstallRun): Promise<{ entry: string; version: string }> {
  const packageRoot = join(prefix, "node_modules", agentPackages[kind]);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string; bin?: string | Record<string, string> };
  if (manifest.name !== agentPackages[kind] || typeof manifest.version !== "string" || !parseAgentVersion(manifest.version) || requested !== "latest" && manifest.version !== requested) throw new Error("安装包名称或版本不匹配");
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[kind];
  if (typeof bin !== "string") throw new Error("缺少 CLI 入口");
  const entry = resolve(packageRoot, bin);
  if (!within(packageRoot, entry) || !/\.(?:m?js|cjs)$/i.test(entry) || !within(await realpath(packageRoot), await realpath(entry))) throw new Error("CLI 入口格式不受支持");
  const output = await run(process.execPath, [entry, "--version"], { signal, timeout: 15_000 });
  if (compareAgentVersions(extractAgentVersion(output.stdout + "\n" + output.stderr) ?? "", manifest.version) !== 0) throw new Error("Agent 实际运行版本与安装包版本不一致");
  return { entry, version: manifest.version };
}

/** Update a detected npm installation in its original prefix, or prepare an isolated managed version. */
export async function installAgentPackage(
  kind: AgentKind, version: string, root: string, signal: AbortSignal,
  onProgress?: (progress: AgentInstallProgress) => void,
  options: { existingEntry?: string; run?: InstallRun } = {},
): Promise<{ entry: string; version: string; id?: string }> {
  root = resolve(root);
  installPackage(kind, version); signal.throwIfAborted();
  const run = options.run ?? runAgentInstaller;
  const report = (stage: AgentInstallProgress["stage"], resolvedVersion?: string) => onProgress?.({ kind, stage, ...(resolvedVersion ? { version: resolvedVersion } : {}) });
  const id = randomUUID(); let temporary: string | undefined; let committed = false;
  const external = options.existingEntry !== undefined;
  try {
    report("resolving", version);
    let prefix: string;
    let installations: AgentInstallation[] = [];
    if (options.existingEntry) {
      if (installationSource(options.existingEntry, root) !== "npm") throw new Error("该入口不属于 npm 安装，请选择 Orbis 独立安装");
      const suffix = join("node_modules", agentPackages[kind], agentEntries[kind]);
      if (!resolve(options.existingEntry).toLowerCase().endsWith(sep + suffix.toLowerCase())) throw new Error("无法确定原安装位置，请选择 Orbis 独立安装");
      prefix = resolve(resolve(options.existingEntry).slice(0, -suffix.length));
      // A workspace dependency is not a global installation. Never mutate another project's node_modules.
      if (await exists(join(prefix, "package.json"))) throw new Error("此入口属于项目依赖，请在项目中更新或选择 Orbis 独立安装");
    } else {
      installations = await listManagedAgentInstallations(kind, root);
      prefix = join(root, kind, id);
      temporary = prefix;
      await mkdir(prefix, { recursive: true });
    }
    const npm = await resolveNpmTool(external ? prefix : undefined);
    signal.throwIfAborted(); report("downloading", version);
    await run(npm.command, [...npm.args, "install", ...(external ? ["--global"] : []), "--prefix", prefix, "--include=optional", "--no-audit", "--no-fund", "--fetch-timeout=60000", "--fetch-retries=2", "--fetch-retry-mintimeout=1000", "--fetch-retry-maxtimeout=10000", "--", installPackage(kind, version)], { signal, timeout: 1_800_000, cwd: prefix });
    signal.throwIfAborted(); report("verifying");
    const result = await verifyPackage(kind, prefix, version, signal, run);
    signal.throwIfAborted(); report("activating", result.version);
    if (!external) {
      // The atomic manifest is the commit point. Keep paths stable for native packages/postinstall shims.
      signal.throwIfAborted();
      installations = installations.map(item => ({ ...item, active: false }));
      installations.unshift({ id, kind, ...result, installedAt: new Date().toISOString(), active: true });
      await saveInstallations(root, kind, installations);
    }
    committed = true; report("done", result.version);
    return { ...result, ...(!external ? { id } : {}) };
  } catch (error) {
    let cleanupFailed = false;
    if (temporary && !committed) {
      try {
        if (!within(join(root, kind), temporary)) throw new Error("invalid cleanup target");
        await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch { cleanupFailed = true; }
    }
    const message = (signal.aborted ? "安装已取消" : failureMessage(error)) +
      (external ? "；原位置安装可能已变更，请重新检测，必要时重装" : "；原有 Agent 保持可用") +
      (cleanupFailed ? "。部分临时文件被占用，尚未清理" : "");
    report(signal.aborted ? "cancelled" : "error");
    throw new Error(message);
  }
}

export async function activateManagedAgent(kind: AgentKind, id: string, root: string, signal: AbortSignal): Promise<{ entry: string; version: string }> {
  root = resolve(root);
  const installations = await listManagedAgentInstallations(kind, root);
  const selected = installations.find(item => item.id === id);
  if (!selected) throw new Error("安装记录不存在");
  if (kind === "dsh" && compareAgentVersions(selected.version, DSH_VERSION) === -1) throw new Error(`Orbis 手机接入需要 DeepSeek Harness ${DSH_VERSION} 或兼容版本`);
  const prefix = join(root, kind, selected.id);
  if (!within(join(root, kind), prefix)) throw new Error("安装入口无效");
  const result = await verifyPackage(kind, prefix, selected.version, signal, runAgentInstaller);
  signal.throwIfAborted();
  await saveInstallations(root, kind, installations.map(item => ({ ...item, active: item.id === id })));
  return result;
}

/** CC Switch uses dist-tags, not the multi-megabyte full package manifest. Pi/Codex only track latest. */
export async function fetchNpmLatestVersion(packageName: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`https://registry.npmjs.org/-/package/${packageName.replace("/", "%2f")}/dist-tags`, {
      headers: { accept: "application/json", "user-agent": "orbis-host" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const tags = await response.json() as Record<string, unknown> | null;
    return typeof tags?.latest === "string" && parseAgentVersion(tags.latest) ? tags.latest : undefined;
  } catch { return undefined; }
}

export async function queryAgentStatus(kind: AgentKind, root: string, local: LocalAgent, checkLatest = false): Promise<AgentInstallStatus> {
  const installations = await listManagedAgentInstallations(kind, root);
  const status: AgentInstallStatus = { ...local, kind, package: agentPackages[kind], updateAvailable: false, installationSource: installationSource(local.entry, root), installations, copies: [] };
  if (status.installationSource === "npm" && local.entry) {
    const suffix = join("node_modules", agentPackages[kind], agentEntries[kind]);
    const prefix = resolve(resolve(local.entry).slice(0, -suffix.length));
    if (!resolve(local.entry).toLowerCase().endsWith(sep + suffix.toLowerCase()) || await exists(join(prefix, "package.json"))) status.installationSource = "custom";
  }
  if (checkLatest) {
    const latest = await fetchNpmLatestVersion(agentPackages[kind]);
    if (latest) { status.latestVersion = latest; status.updateAvailable = compareAgentVersions(latest, local.version ?? "") === 1; }
    else status.latestError = "最新版本查询失败，可重试或直接指定版本安装";
  }
  const recommended = recommendedAgentVersion(kind, status.latestVersion);
  if (recommended) {
    status.recommendedVersion = recommended;
    status.updateAvailable = compareAgentVersions(recommended, local.version ?? "") === 1;
    if (kind === "dsh" && recommended !== status.latestVersion) status.compatibilityNote = `Orbis 手机接入需要 ${DSH_VERSION} 或兼容版本，推荐安装 ${recommended}`;
  }
  return status;
}

/** Enumerate npm copies in PATH order, including packages whose CLI entry is missing. */
export async function findAgentCopies(kind: AgentKind, env: NodeJS.ProcessEnv): Promise<{ entry: string; version?: string }[]> {
  const roots = (env.PATH ?? env.Path ?? "").split(delimiter).map(value => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  if (env.APPDATA) roots.push(join(env.APPDATA, "npm"));
  const copies: { entry: string; version?: string }[] = []; const seen = new Set<string>();
  for (const prefix of roots) {
    const packageRoot = join(prefix, "node_modules", agentPackages[kind]);
    try {
      const actual = (await realpath(packageRoot)).toLowerCase();
      if (seen.has(actual)) continue;
      seen.add(actual);
      const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version?: string; name?: string };
      if (manifest.name !== agentPackages[kind]) continue;
      copies.push({ entry: join(packageRoot, agentEntries[kind]), ...(typeof manifest.version === "string" ? { version: manifest.version } : {}) });
    } catch { /* Not installed at this PATH entry. */ }
  }
  return copies;
}
