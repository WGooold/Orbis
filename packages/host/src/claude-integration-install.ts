import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { agentInvocation, findExternalAgentEntries } from "./agent-command.js";
import { requireClaudeModsVersion } from "./claude-version.js";

/**
 * Registers the Orbis Claude Code plugin through Claude Code's own plugin CLI
 * (ADR-0033 §1). The plugin directory doubles as a local marketplace, so Claude
 * loads it in place and an app update only needs the marketplace re-pointed.
 * Nothing here edits Claude's settings files directly.
 */
export const CLAUDE_MARKETPLACE = "orbis-host";
export const CLAUDE_PLUGIN = "orbis-host-session-link";

export type ClaudeCommandResult = { code: number; stdout: string; stderr: string };
export type ClaudeCommandRunner = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<ClaudeCommandResult>;
export type ClaudeIntegrationResult = "installed" | "removed" | "claude_not_found" | "disabled";

export class ClaudeIntegrationError extends Error {
  constructor(message: string) { super(message); this.name = "ClaudeIntegrationError"; }
}

export async function findClaudeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  home = platform === "win32" ? env.USERPROFILE || homedir() : env.HOME || homedir()): Promise<string | undefined> {
  return (await findExternalAgentEntries("claude", env, platform, home))[0]?.entry;
}

export async function updateClaudeIntegration(input: {
  pluginDir: string;
  uninstall: boolean;
  /** Windows setup preserves a setting explicitly disabled in the desktop app. */
  desktopSettingsPath?: string;
  env?: NodeJS.ProcessEnv;
  claude?: string;
  run?: ClaudeCommandRunner;
}): Promise<ClaudeIntegrationResult> {
  if (!input.uninstall && input.desktopSettingsPath && !await integrationEnabled(input.desktopSettingsPath)) return "disabled";
  const env = input.env ?? process.env;
  const claude = input.claude ?? await findClaudeExecutable(env);
  if (claude === undefined) return "claude_not_found";
  const run = input.run ?? runClaude;
  const plugin = `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`;
  // Callers derive this from a directory URL, which keeps a trailing separator. Claude Code
  // rejects that form with "Path does not exist: <dir>\" for a directory that exists.
  const pluginDir = input.pluginDir.replace(/[\\/]+$/u, "");
  if (input.uninstall) {
    // Removing what is already absent is success; Claude reports it on stderr only.
    await run(claude, ["plugin", "uninstall", plugin, "--scope", "user"], env);
    await run(claude, ["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE], env);
    return "removed";
  }
  await requireClaudeModsVersion(claude, env, undefined, input.run);
  // `add` re-points an existing marketplace of the same name, and `install` is idempotent.
  await expectSuccess(run(claude, ["plugin", "marketplace", "add", pluginDir], env), "登记 Orbis 插件目录失败");
  await expectSuccess(run(claude, ["plugin", "install", plugin, "--scope", "user"], env), "安装 Orbis Claude Code 插件失败");
  // Repeating `install` leaves an existing cached version unchanged. Refresh it
  // from the bundled marketplace so a Host upgrade also delivers plugin fixes.
  await expectSuccess(run(claude, ["plugin", "update", plugin, "--scope", "user"], env), "更新 Orbis Claude Code 插件失败");
  return "installed";
}

async function integrationEnabled(path: string): Promise<boolean> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  // QSettings writes this boolean in [General]. Do not mistake another section's key for it.
  let section = "General";
  for (const raw of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) { section = header[1]!; continue; }
    if (section === "General" && /^claudeIntegrationEnabled\s*=\s*(?:false|0)\s*$/iu.test(line)) return false;
  }
  return true;
}

async function expectSuccess(pending: Promise<ClaudeCommandResult>, message: string): Promise<void> {
  const result = await pending;
  if (result.code === 0) return;
  const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/u).slice(-3).join(" ").slice(0, 512);
  throw new ClaudeIntegrationError(detail.length === 0 ? message : `${message}：${detail}`);
}

const runClaude: ClaudeCommandRunner = (file, args, env) => new Promise(resolve => {
  const invocation = agentInvocation({ command: file, prefixArgs: [] }, args, env);
  execFile(invocation.command, invocation.args, { env, timeout: 60_000, windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}), maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as unknown as { code: number }).code : 1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
});

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    const { values, positionals } = parseArgs({ options: { uninstall: { type: "boolean" }, settings: { type: "string" } }, allowPositionals: true });
    if (positionals.length !== 1) throw new Error("Usage: claude-integration-install <plugin-dir> [--settings <desktop-settings.ini>] [--uninstall]");
    const result = await updateClaudeIntegration({ pluginDir: positionals[0]!, uninstall: values.uninstall === true,
      ...(values.settings === undefined ? {} : { desktopSettingsPath: values.settings }) });
    console.log(result === "claude_not_found" ? "Claude Code not found; Orbis will retry when the desktop app opens after Claude Code is installed." : result);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
