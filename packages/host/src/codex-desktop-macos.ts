/**
 * Codex Desktop on macOS: the facts Orbis relies on, each checked against the installed bundle rather
 * than inferred from a path shape (ADR-0096).
 *
 * - The application is identified only by `CFBundleIdentifier` `com.openai.codex`. Its bundle is named
 *   `ChatGPT.app`, like the plain ChatGPT app (`com.openai.chat`).
 * - The GUI may start its CLI from any helper nested in the bundle. 26.1117 starts it from
 *   `…/Frameworks/Codex Framework.framework/…/Helpers/Codex (Aperitif).app`, so the launching
 *   installation is the outermost Codex bundle among the wrapper's ancestors, not its parent's bundle.
 * - The bundled CLI is declared by `Contents/Resources/codex-cli/codex-package.json` (`entrypoint`).
 *   Layouts shipped before that manifest remain fallbacks. A terminal or PATH CLI is never substituted:
 *   its version need not match the GUI.
 * - The entry is the launchd user-session `CODEX_CLI_PATH`; a LaunchAgent sets it again at login.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path/posix";
import { promisify } from "node:util";

import type { DesktopCliCandidate } from "./codex-desktop-cli.js";

const execute = promisify(execFile);

export const CODEX_DESKTOP_BUNDLE_ID = "com.openai.codex";

/** Common install locations; Spotlight is consulted only when none of them is the Codex bundle. */
export function codexDesktopAppCandidates(home = homedir()): string[] {
  return ["/Applications", join(home, "Applications")].flatMap(root => ["ChatGPT.app", "Codex.app"].map(name => join(root, name)));
}

function xmlUnescape(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

/** XML plists are read in process (presence scans many bundles); binary ones go through plutil. */
async function plistValue(file: string, key: string): Promise<string | undefined> {
  try {
    const text = readFileSync(file);
    if (!text.subarray(0, 6).equals(Buffer.from("bplist"))) {
      const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u").exec(text.toString("utf8"));
      const value = match === null ? undefined : xmlUnescape(match[1]!).trim();
      return value ? value : undefined;
    }
  } catch { return undefined; }
  try {
    const { stdout } = await execute("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", file], { timeout: 5_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const identifiers = new Map<string, { mtimeMs: number; value: Promise<string | undefined> }>();

/** Cached by Info.plist modification time: Host polls presence every few seconds. */
export function bundleIdentifier(app: string): Promise<string | undefined> {
  const plist = join(app, "Contents", "Info.plist");
  let mtimeMs: number;
  try { mtimeMs = statSync(plist).mtimeMs; }
  catch { return Promise.resolve(undefined); }
  const cached = identifiers.get(app);
  if (cached?.mtimeMs === mtimeMs) return cached.value;
  const value = plistValue(plist, "CFBundleIdentifier");
  identifiers.set(app, { mtimeMs, value });
  return value;
}

/** Every `.app` directory containing a path, outermost first. */
export function enclosingAppBundles(path: string): string[] {
  const parts = resolve(path).split("/");
  const result: string[] = [];
  for (let index = 1; index < parts.length - 1; index++) {
    if (parts[index]!.endsWith(".app")) result.push(parts.slice(0, index + 1).join("/"));
  }
  return result;
}

/** The outermost Codex bundle containing a path; helpers nest their own bundles inside it. */
export async function codexBundleContaining(path: string, identify = bundleIdentifier): Promise<string | undefined> {
  for (const app of enclosingAppBundles(path)) if (await identify(app) === CODEX_DESKTOP_BUNDLE_ID) return app;
  return undefined;
}

/** `<app>/Contents/MacOS/<exe>` → `<app>`; anything else is not a bundle's main executable. */
export function appBundleOf(executable: string): string | undefined {
  const macos = dirname(executable);
  const contents = dirname(macos);
  if (!macos.endsWith("/Contents/MacOS") || !contents.endsWith(".app/Contents")) return undefined;
  return dirname(contents);
}

/** Main executable of a Codex bundle (`<app>/Contents/MacOS/<CFBundleExecutable>`). */
export async function codexDesktopExecutableOf(app: string): Promise<string | undefined> {
  if (!existsSync(join(app, "Contents", "Info.plist"))) return undefined;
  if (await bundleIdentifier(app) !== CODEX_DESKTOP_BUNDLE_ID) return undefined;
  const name = await plistValue(join(app, "Contents", "Info.plist"), "CFBundleExecutable");
  return name === undefined ? undefined : join(app, "Contents", "MacOS", name);
}

/** Not finding the bundle means "not installed"; a failed Spotlight query is treated the same way. */
export async function resolveMacCodexDesktopExecutable(candidates = codexDesktopAppCandidates()): Promise<string | undefined> {
  for (const app of candidates) {
    const executable = await codexDesktopExecutableOf(app);
    if (executable !== undefined) return executable;
  }
  let found: string[] = [];
  try {
    const { stdout } = await execute("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == "${CODEX_DESKTOP_BUNDLE_ID}"`], { timeout: 5_000 });
    // Ignore copies nested in another bundle, in the Trash or kept as update backups.
    found = stdout.split("\n").map(line => line.trim())
      .filter(line => line.endsWith(".app") && enclosingAppBundles(join(line, "Contents")).length === 1
        && !/\/\.Trash\/|\/Backups?\//iu.test(line));
  } catch { /* Spotlight unavailable */ }
  for (const app of found) {
    const executable = await codexDesktopExecutableOf(app);
    if (executable !== undefined) return executable;
  }
  return undefined;
}

const CLI_ROOT = ["Contents", "Resources", "codex-cli"] as const;
/** Entries shipped before `codex-package.json`: the forwarding script and the signed binary. */
const LEGACY_CLI_ENTRIES = ["bin/codex", "CodexCLI.app/Contents/MacOS/codex"] as const;

/** The CLI a Codex bundle declares, then the earlier layouts, all inside that bundle. */
export function bundledCodexCliPaths(app: string): string[] {
  const root = join(app, ...CLI_ROOT);
  const paths: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(root, "codex-package.json"), "utf8")) as { entrypoint?: unknown };
    if (typeof manifest.entrypoint === "string" && manifest.entrypoint.length > 0 && !isAbsolute(manifest.entrypoint)) {
      const entry = resolve(root, manifest.entrypoint);
      if (entry.startsWith(`${root}/`)) paths.push(entry);
    }
  } catch { /* No manifest before layoutVersion 1. */ }
  for (const entry of LEGACY_CLI_ENTRIES) {
    const path = join(root, entry);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export type MacProcess = { pid: number; parent: number; executable: string };

/** One snapshot: `comm` is the full executable path on macOS. */
export async function macProcessTable(): Promise<MacProcess[]> {
  const { stdout } = await execute("/bin/ps", ["-axww", "-o", "pid=,ppid=,comm="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), parent: Number(match[2]), executable: match[3]!.trim() }];
  });
}

/** Ancestors of a process, nearest first, stopping before launchd. */
export function processAncestry(table: readonly MacProcess[], start: number, limit = 16): MacProcess[] {
  const byPid = new Map(table.map(row => [row.pid, row]));
  const result: MacProcess[] = [];
  const seen = new Set<number>();
  for (let pid = start; pid > 1 && !seen.has(pid) && result.length < limit;) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (row === undefined) break;
    result.push(row);
    pid = row.parent;
  }
  return result;
}

/** Running Codex GUI main processes. Helpers live in nested bundles and never match. */
export async function runningCodexDesktops(table?: readonly MacProcess[], identify = bundleIdentifier): Promise<Array<{ pid: number; executable: string; app: string }>> {
  const rows = table ?? await macProcessTable();
  const result: Array<{ pid: number; executable: string; app: string }> = [];
  for (const row of rows) {
    const app = appBundleOf(row.executable);
    // Only outermost bundles: a helper's own bundle is never the application.
    if (app === undefined || enclosingAppBundles(row.executable).length !== 1) continue;
    if (await identify(app) === CODEX_DESKTOP_BUNDLE_ID) result.push({ pid: row.pid, executable: row.executable, app });
  }
  return result;
}

/** Kept for the terminal integration, which resolves a single process. */
export async function processExecutable(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execute("/bin/ps", ["-ww", "-o", "comm=", "-p", String(pid)], { timeout: 5_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export type MacDesktopCliOptions = {
  /** First process whose ancestry identifies the launching GUI; the wrapper's parent by default. */
  launchingPid?: number;
  processTable?: () => Promise<readonly MacProcess[]>;
  identify?: (app: string) => Promise<string | undefined>;
  installedExecutable?: () => Promise<string | undefined>;
  log?: (message: string) => void;
};

export type MacDesktopCliResolution = {
  candidates: DesktopCliCandidate[];
  /** `ancestor`: this invocation descends from that Desktop; only such a backend may be published. */
  origin: "ancestor" | "running" | "installed" | "explicit" | "none";
  app?: string;
  /** The process table could not be read, so whether a Desktop launched us is unknown. */
  uncertain?: string;
};

async function launchingCodexBundle(options: MacDesktopCliOptions, log: (message: string) => void, unknown: (reason: string) => void): Promise<{ app: string; origin: "ancestor" | "running" | "installed" } | undefined> {
  const identify = options.identify ?? bundleIdentifier;
  let table: readonly MacProcess[] | undefined;
  try { table = await (options.processTable ?? macProcessTable)(); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`无法读取进程表：${reason}`);
    unknown(reason);
  }
  if (table !== undefined) {
    for (const row of processAncestry(table, options.launchingPid ?? process.ppid)) {
      const app = await codexBundleContaining(row.executable, identify);
      if (app !== undefined) return { app, origin: "ancestor" };
    }
    // Started outside a Codex process tree (another tool honouring CODEX_CLI_PATH, or by hand).
    const running = [...new Set((await runningCodexDesktops(table, identify)).map(entry => entry.app))];
    if (running.length === 1) return { app: running[0]!, origin: "running" };
    if (running.length > 1) log(`有多个 Codex 桌面版在运行，无法确定发起者：${running.join("，")}`);
  }
  const installed = await (options.installedExecutable ?? resolveMacCodexDesktopExecutable)().catch(() => undefined);
  const app = installed === undefined ? undefined : appBundleOf(installed);
  return app === undefined ? undefined : { app, origin: "installed" };
}

function realpathOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * CLI candidates for the launching Desktop, in the order the GUI itself would use them. Each candidate
 * is an existing executable file inside that bundle; an explicit `ORBIS_CODEX_REAL` comes first.
 */
export async function macDesktopCliCandidates(env: NodeJS.ProcessEnv, options: MacDesktopCliOptions = {}): Promise<MacDesktopCliResolution> {
  const log = options.log ?? (() => {});
  const candidates: DesktopCliCandidate[] = [];
  const seen = new Set<string>();
  const entry = env.CODEX_CLI_PATH?.trim();
  const self = entry ? realpathOrResolve(entry) : undefined;
  const add = (command: string, source: string, bundleRoot?: string): void => {
    let path: string;
    try { path = realpathSync(command); }
    catch (error) { log(`${source} 不可用：${command}（${(error as NodeJS.ErrnoException).code ?? String(error)}）`); return; }
    if (path === self || basename(path) === "codex-launcher") { log(`忽略指回 Orbis 包装器的 CLI：${command}`); return; }
    if (bundleRoot !== undefined && !path.startsWith(`${bundleRoot}/`)) { log(`${source} 指向应用包之外，跳过：${command}`); return; }
    if (seen.has(path)) return;
    try {
      if (!statSync(path).isFile()) throw new Error("不是普通文件");
      accessSync(path, constants.X_OK);
    } catch (error) { log(`${source} 不可执行：${command}（${(error as NodeJS.ErrnoException).code ?? String(error)}）`); return; }
    seen.add(path);
    candidates.push({ command, prefixArgs: [], source });
  };
  const explicit = env.ORBIS_CODEX_REAL?.trim();
  if (explicit) add(resolve(explicit), "ORBIS_CODEX_REAL");
  let uncertain: string | undefined;
  const launching = await launchingCodexBundle(options, log, reason => { uncertain = reason; });
  const unknown = uncertain === undefined ? {} : { uncertain };
  if (launching === undefined) {
    if (candidates.length === 0) log("未找到 Codex 桌面版安装包");
    return { candidates, origin: candidates.length > 0 ? "explicit" : "none", ...unknown };
  }
  const root = realpathOrResolve(launching.app);
  const explicitFirst = candidates.length > 0;
  for (const path of bundledCodexCliPaths(launching.app)) add(path, `desktop-${launching.origin}`, root);
  // A deliberate override (development, isolated tests) is honoured even when another Codex runs.
  const origin = launching.origin !== "ancestor" && explicitFirst ? "explicit" : launching.origin;
  return { candidates, origin, app: launching.app, ...unknown };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The executable Codex runs through `CODEX_CLI_PATH`. It must never be the reason Codex cannot start:
 * when Orbis's runtime is gone it executes the CLI of the launching Desktop, found with the same rule
 * as the wrapper (outermost Codex bundle among its ancestors, manifest entry first).
 */
export function renderMacCodexLauncher(options: { node: string; script: string; endpoint?: string }): string {
  return [
    "#!/bin/bash",
    "# Generated by Orbis Host. Codex Desktop runs this through CODEX_CLI_PATH; see ADR-0096.",
    // Continue only when the kernel refuses an exec; a started command's status is never replayed.
    "set +e",
    "shopt -s execfail",
    `node=${shellQuote(options.node)}`,
    `script=${shellQuote(options.script)}`,
    ...(options.endpoint === undefined ? [] : [
      `if [ -z "\${ORBIS_CODEX_DESKTOP_ENDPOINT:-}" ]; then export ORBIS_CODEX_DESKTOP_ENDPOINT=${shellQuote(options.endpoint)}; fi`,
    ]),
    // Native mode: the wrapper could not run this invocation and asked for the Desktop's own CLI.
    'if [ "${ORBIS_CODEX_LAUNCHER_NATIVE:-}" != "1" ]; then',
    '  if [ -f "$node" ] && [ -x "$node" ] && [ -f "$script" ] && [ -r "$script" ]; then exec "$node" "$script" "$@"; fi',
    '  echo "[orbis-codex-launcher] Orbis runtime unavailable; starting the Codex CLI without Orbis" >&2',
    "fi",
    'run_cli() { local cli="$1"; shift; if [ -n "$cli" ] && [ -f "$cli" ] && [ -x "$cli" ] && ! [ "$cli" -ef "$0" ]; then exec "$cli" "$@"; fi; }',
    'real="${ORBIS_CODEX_REAL:-}"',
    'if [ -n "$real" ]; then run_cli "$real" "$@"; fi',
    "codex_bundle() {",
    '  local rest="$1" prefix="" head app',
    '  while [[ "$rest" == *.app/* ]]; do',
    '    head="${rest%%.app/*}.app"',
    '    app="$prefix$head"',
    `    if [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null)" = ${shellQuote(CODEX_DESKTOP_BUNDLE_ID)} ]; then printf '%s\\n' "$app"; return 0; fi`,
    '    prefix="$app/"',
    '    rest="${rest#"$head"/}"',
    "  done",
    "  return 1",
    "}",
    'pid=$PPID',
    "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do",
    '  [ -n "$pid" ] && [ "$pid" -gt 1 ] 2>/dev/null || break',
    '  exe=$(/bin/ps -ww -o comm= -p "$pid" 2>/dev/null)',
    '  if app=$(codex_bundle "$exe"); then',
    '    cli="$app/Contents/Resources/codex-cli"',
    '    entry=$(/usr/bin/plutil -extract entrypoint raw -o - "$cli/codex-package.json" 2>/dev/null)',
    '    case "$entry" in ""|/*|*..*) ;; *) run_cli "$cli/$entry" "$@" ;; esac',
    ...LEGACY_CLI_ENTRIES.map(path => `    run_cli "$cli/${path}" "$@"`),
    "    break",
    "  fi",
    '  pid=$(/bin/ps -o ppid= -p "$pid" 2>/dev/null | tr -d " ")',
    "done",
    'echo "[orbis-codex-launcher] no runnable Codex CLI found in the launching Codex Desktop bundle" >&2',
    "exit 127",
    "",
  ].join("\n");
}

/** Read back the endpoint a generated launcher exports, so a refresh keeps a custom state directory. */
export function launcherEndpoint(text: string | undefined): string | undefined {
  const line = text?.split("\n").find(value => value.includes("export ORBIS_CODEX_DESKTOP_ENDPOINT="));
  const match = line === undefined ? null : /export ORBIS_CODEX_DESKTOP_ENDPOINT='((?:[^']|'\\'')*)'/u.exec(line);
  return match === null ? undefined : match[1]!.replaceAll(`'\\''`, "'");
}

/** The LaunchAgent that restores the entry at login: `launchctl setenv` lasts only for the session. */
export const CODEX_DESKTOP_ENTRY_AGENT = "dev.orbis.codex-desktop-entry";

export function codexDesktopEntryAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${CODEX_DESKTOP_ENTRY_AGENT}.plist`);
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderCodexDesktopEntryAgent(name: string, value: string): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${CODEX_DESKTOP_ENTRY_AGENT}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/launchctl</string>",
    "    <string>setenv</string>",
    `    <string>${xmlEscape(name)}</string>`,
    `    <string>${xmlEscape(value)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function readLaunchdEnvironment(name: string): Promise<string | undefined> {
  const { stdout } = await execute("/bin/launchctl", ["getenv", name], { timeout: 5_000 });
  const value = stdout.trim();
  return value.length > 0 ? value : undefined;
}

/** Only clear the exact environment value and generated login item this entry owns. */
export async function clearLaunchdEnvironment(name: string, expected: string, home = homedir()): Promise<void> {
  const agent = codexDesktopEntryAgentPath(home);
  const saved = await readFile(agent, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (saved !== undefined && saved !== renderCodexDesktopEntryAgent(name, expected)) throw new Error("Codex 桌面登录项已改变，未修改");
  const current = await readLaunchdEnvironment(name);
  if (current !== undefined && current !== expected) throw new Error(`${name} 已改变，未修改`);
  // Remove the login item first so it cannot restore a suspended entry at the next login.
  if (saved !== undefined) await rm(agent, { force: true });
  if (current !== undefined) await execute("/bin/launchctl", ["unsetenv", name], { timeout: 5_000 });
  if (await readLaunchdEnvironment(name) !== undefined) throw new Error(`${name} 未成功移除`);
}

/** Register the session override, and persist it across logins on a best-effort basis. */
export async function writeLaunchdEnvironment(name: string, value: string, home = homedir()): Promise<void> {
  const agent = codexDesktopEntryAgentPath(home);
  await execute("/bin/launchctl", ["setenv", name, value], { timeout: 5_000 });
  const content = renderCodexDesktopEntryAgent(name, value);
  const current = await readFile(agent, "utf8").catch(() => undefined);
  if (current === content) return;
  try {
    await mkdir(dirname(agent), { recursive: true });
    await writeFile(agent, content, { mode: 0o644 });
  } catch { /* Host writes it again before the next login. */ }
}
