/** Local CLI discovery and invocation. Keep launchers stable across native/package-manager updates. */
import { execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { agentInstallRoot } from "./agent-root.js";

export type ExternalAgentKind = "pi" | "dsh" | "claude";
export type AgentCommand = {
  command: string;
  prefixArgs: string[];
  /** Package bin used for protocol imports; it is not necessarily the command being executed. */
  packageEntry?: string;
};
export const AGENT_LAUNCH_ENV_KEYS = ["PATH", "PI_CODING_AGENT_DIR", "PI_MANAGED_INSTALL_ROOT", "CODEX_HOME", "DSH_HOME",
  "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL", "NVM_DIR", "FNM_DIR", "FNM_MULTISHELL_PATH", "NVM_SYMLINK"] as const;
const packages = {
  pi: ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
  dsh: ["@deepseek-ai/dsh"], claude: ["@anthropic-ai/claude-code"],
};
const legacyBins = { pi: "dist/bundle/cli.js", dsh: "lib/bin.js", claude: "cli.js" };
const execute = promisify(execFile);

export function cliPathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return (env.PATH ?? env.Path ?? env.path ?? "").split(platform === "win32" ? ";" : ":")
    .map(value => value.trim().replace(/^"(.*)"$/u, "$1")).filter(Boolean);
}

function homePath(value: string, home: string): string {
  return value === "~" ? home : /^~[/\\]/u.test(value) ? join(home, value.slice(2)) : value;
}

export function cliSearchDirs(kind: ExternalAgentKind, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const roots = cliPathDirs(env, platform);
  if (kind === "pi") {
    roots.push(join(homePath(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), home), "bin"));
    if (env.PI_MANAGED_INSTALL_ROOT) roots.push(join(dirname(homePath(env.PI_MANAGED_INSTALL_ROOT, home)), "bin"));
  }
  roots.push(join(home, ".local", "bin"));
  if (kind === "claude") roots.push(join(home, ".claude", "local"));
  for (const dir of [env.PNPM_HOME, env.NVM_SYMLINK, env.FNM_MULTISHELL_PATH]) if (dir) roots.push(dir);
  for (const dir of [env.VOLTA_HOME || join(home, ".volta"), env.BUN_INSTALL || join(home, ".bun")]) roots.push(join(dir, "bin"));
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (prefix) roots.push(platform === "win32" ? prefix : join(prefix, "bin"));
  if (platform === "win32") {
    if (env.APPDATA) roots.push(join(env.APPDATA, "npm"));
    roots.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Microsoft", "WinGet", "Links"));
  }
  return [...new Set(roots)];
}

function cliNames(kind: ExternalAgentKind, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [kind];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";")
    .filter(value => [".com", ".exe", ".bat", ".cmd", ".ps1"].includes(value));
  return [...new Set([...extensions, ".exe", ".cmd", ".bat", ".ps1"])].map(extension => kind + extension);
}

async function header(path: string): Promise<string> {
  try {
    const file = await open(path, "r");
    try { const buffer = Buffer.alloc(16_384); const { bytesRead } = await file.read(buffer); return buffer.toString("utf8", 0, bytesRead); }
    finally { await file.close(); }
  } catch { return ""; }
}

export async function isOrbisPiCommand(path: string): Promise<boolean> {
  return (await header(path.trim().replace(/^"(.*)"$/u, "$1"))).includes("orbis-pi-command");
}

async function executable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try { await access(path, platform === "win32" ? constants.F_OK : constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

type PackageBin = { entry: string; version?: string };
async function packageBin(kind: ExternalAgentKind, root: string): Promise<PackageBin | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (!packages[kind].includes(manifest.name)) return;
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[kind];
    const entry = resolve(root, typeof bin === "string" ? bin : legacyBins[kind]);
    const rel = relative(root, entry);
    if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return;
    return { entry, ...(typeof manifest.version === "string" ? { version: manifest.version } : {}) };
  } catch { return; }
}

/** Only accept the named package's declared bin, never an unrelated nearby node_modules. */
async function owningPackage(kind: ExternalAgentKind, entry: string): Promise<PackageBin | undefined> {
  let actual: string;
  try { actual = await realpath(entry); } catch { return; }
  for (let root = dirname(actual); ; root = dirname(root)) {
    const bin = await packageBin(kind, root);
    if (bin && await realpath(bin.entry).catch(() => undefined) === actual) return { ...bin, entry: actual };
    if (dirname(root) === root) return;
  }
}

export async function resolveAgentPackage(kind: ExternalAgentKind, entry: string, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): Promise<PackageBin | undefined> {
  entry = entry.trim().replace(/^"(.*)"$/u, "$1");
  const direct = await owningPackage(kind, entry);
  if (direct) return direct;
  const text = await header(entry);
  // npm/pnpm wrappers name their target relative to the wrapper. Read literals only;
  // never evaluate a shell script or guess a different installation from PATH.
  for (const match of text.matchAll(/(?:%~dp0|%dp0%|\$\{basedir\}|\$basedir)[/\\]?([^"'\r\n`]+?\.(?:c|m)?js)(?=["'\s]|$)/gu)) {
    const target = resolve(dirname(entry), match[1]!.replaceAll("\\", "/"));
    const found = await owningPackage(kind, target);
    if (found) return found;
  }
  // Volta's native shim has no package path in its contents. Ask the same manager
  // used by the launcher, in the DSH Web service's working directory.
  const home = platform === "win32" ? env.USERPROFILE || homedir() : env.HOME || homedir();
  const volta = join(env.VOLTA_HOME || join(home, ".volta"), "bin");
  if (resolve(dirname(entry)) === resolve(volta)) {
    const manager = join(volta, platform === "win32" ? "volta.exe" : "volta");
    try {
      const { stdout } = await execute(manager, ["which", kind], { env, cwd: home, timeout: 5000, windowsHide: true, maxBuffer: 16_384 });
      if (isAbsolute(stdout.trim())) return await owningPackage(kind, stdout.trim());
    } catch { /* A broken manager must not select an unrelated package. */ }
  }
  return;
}

/** PATH order wins. A broken selected package is retained so detection reports it. */
export async function findExternalAgentEntries(kind: ExternalAgentKind, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform,
  home = platform === "win32" ? env.USERPROFILE || homedir() : env.HOME || homedir()): Promise<PackageBin[]> {
  const result: PackageBin[] = []; const seen = new Set<string>();
  const add = async (copy: PackageBin, identity = copy.entry) => {
    const actual = await realpath(identity).catch(() => resolve(identity));
    const key = platform === "win32" ? actual.toLowerCase() : actual;
    if (!seen.has(key)) { seen.add(key); result.push(copy); }
  };
  for (const directory of cliSearchDirs(kind, env, platform, home)) {
    let launcher: string | undefined;
    for (const name of cliNames(kind, env, platform)) {
      const candidate = resolve(directory, name);
      if (kind === "pi" && await isOrbisPiCommand(candidate)) continue;
      // Preserve broken symlinks as broken defaults instead of silently switching versions.
      const link = await lstat(candidate).then(value => value.isSymbolicLink()).catch(() => false);
      if (await executable(candidate, platform) || link) { launcher = candidate; break; }
    }
    if (launcher) {
      const bin = await resolveAgentPackage(kind, launcher, env, platform);
      await add({ entry: launcher, ...(bin?.version === undefined ? {} : { version: bin.version }) }, bin?.entry);
      continue;
    }
    if (kind === "claude") continue;
    const modules = [join(directory, "node_modules"), ...(platform !== "win32" && basename(directory) === "bin" ? [join(dirname(directory), "lib", "node_modules")] : [])];
    for (const root of modules) for (const name of packages[kind]) {
      const bin = await packageBin(kind, join(root, name));
      if (bin) await add(bin);
      else {
        // Old standalone Host configuration and partially installed npm packages may have no manifest.
        const entry = join(root, name, legacyBins[kind]);
        if (!await access(join(root, name, "package.json")).then(() => true, () => false)
          && await stat(entry).then(value => value.isFile()).catch(() => false)) await add({ entry });
      }
    }
  }
  return result;
}

/** Managed JS uses the bundled Node; external launchers choose their own runtime. */
export async function agentCommandForEntry(entry: string, env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): Promise<AgentCommand> {
  entry = entry.trim().replace(/^"(.*)"$/u, "$1");
  await access(entry);
  if (!/\.[cm]?js$/iu.test(entry)) return { command: entry, prefixArgs: [] };
  const managed = relative(agentInstallRoot(env, platform), resolve(entry));
  if (managed && managed !== ".." && !managed.startsWith(".." + sep) && !isAbsolute(managed))
    return { command: process.execPath, prefixArgs: [entry] };
  const shebang = (await header(entry)).split(/\r?\n/u, 1)[0] ?? "";
  if (platform !== "win32" && shebang.startsWith("#!") && await executable(entry, platform)) return { command: entry, prefixArgs: [] };
  const runtime = /^#!.*\bbun\b/u.test(shebang) ? "bun" : "node";
  const name = runtime + (platform === "win32" ? ".exe" : "");
  const dirs = cliPathDirs(env, platform);
  // An npm prefix can supply its own Node even when the launch shim was removed.
  const normalized = entry.replaceAll("\\", "/");
  const index = normalized.indexOf("/node_modules/");
  if (index >= 0) {
    const prefix = normalized.slice(0, index);
    dirs.unshift(platform !== "win32" && basename(prefix) === "lib" ? join(dirname(prefix), "bin") : prefix);
  }
  for (const dir of dirs) if (await executable(join(dir, name), platform)) return { command: join(dir, name), prefixArgs: [entry] };
  if (runtime === "bun") throw new Error("找不到此 CLI 启动脚本需要的 Bun，请检查启动路径");
  return { command: process.execPath, prefixArgs: [entry] };
}

/** Convert only local Windows script entries to their interpreter; arguments remain data. */
export function agentInvocation(cli: AgentCommand, args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const argv = [...cli.prefixArgs, ...args];
  if (platform !== "win32") return { command: cli.command, args: argv };
  if (/\.ps1$/iu.test(cli.command)) {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference = 'Stop'; & ${[cli.command, ...argv].map(quote).join(" ")}; exit $LASTEXITCODE`;
    return { command: join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
  }
  if (!/\.(?:cmd|bat)$/iu.test(cli.command)) return { command: cli.command, args: argv };
  if ([cli.command, ...argv].some(value => /[\0\r\n]/u.test(value))) throw new Error("Windows CLI 启动参数包含无效换行或空字符");
  // Escape both the cmd parser and the native argv parser behind npm/pnpm's `%*`.
  const meta = /([()\][%!^"`<>&|;, *?])/gu;
  const escape = (value: string) => value.replace(meta, "^$1");
  const quote = (value: string) => {
    // `\"` leaves cmd's quoting state unbalanced — the next argument's `&` or `|` then splits
    // the command — while `""` is a literal quote for cmd and, with the preceding backslashes
    // doubled, is still one quote for CommandLineToArgvW after the batch re-expands `%*`.
    const quoted = '"' + value.replace(/(\\*)"/gu, '$1$1""').replace(/(\\+)$/u, "$1$1") + '"';
    const escaped = escape(quoted);
    return /node_modules[/\\]\.bin[/\\]/iu.test(cli.command) ? escape(escaped) : escaped;
  };
  return { command: env.ComSpec || env.COMSPEC || env.comspec || "cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", `"${[escape(cli.command), ...argv.map(quote)].join(" ")}"`], windowsVerbatimArguments: true };
}

/** Windows terminals must use exactly the same cmd argv as probes/headless startup.
 * ProcessStartInfo avoids PowerShell re-quoting a cmd /c command line. */
export function agentPowerShellScript(cli: AgentCommand, args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const invocation = agentInvocation(cli, args, env, "win32");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  if (!invocation.windowsVerbatimArguments) return ["&", invocation.command, ...invocation.args]
    .map((value, index) => index === 0 ? value : quote(value)).join(" ");
  return `$orbisStartInfo = New-Object System.Diagnostics.ProcessStartInfo; `
    + `$orbisStartInfo.FileName = ${quote(invocation.command)}; $orbisStartInfo.Arguments = ${quote(invocation.args.join(" "))}; `
    + `$orbisStartInfo.UseShellExecute = $false; $orbisAgentProcess = [System.Diagnostics.Process]::Start($orbisStartInfo); `
    + `$orbisAgentProcess.WaitForExit(); $global:LASTEXITCODE = $orbisAgentProcess.ExitCode`;
}

/** Stop only the owned invocation tree; POSIX callers requesting a tree must spawn detached. */
export async function stopAgentProcess(child: ChildProcess, env: NodeJS.ProcessEnv = process.env, tree = true): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && tree) {
    await execute(join(env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000, maxBuffer: 16_384 }).catch(() => { child.kill(); });
  } else if (tree && process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else child.kill("SIGTERM");
}
