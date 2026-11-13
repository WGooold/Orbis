import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { agentInvocation } from "./agent-command.js";
import { compareAgentVersions, extractAgentVersion, parseAgentVersion } from "./agent-installation.js";

/** CLAUDE-MODS-MIN-01: the official terminal Mods floor, shared by discovery, launch and hello. */
export const CLAUDE_MIN_VERSION = "2.1.287";

export function supportsClaudeMods(version: string, minimum = CLAUDE_MIN_VERSION): boolean {
  const comparison = compareAgentVersions(version.replace(/^v/u, ""), minimum.replace(/^v/u, ""));
  return comparison !== undefined && comparison >= 0;
}

export function claudeVersionRequirement(version: string): string | undefined {
  if (supportsClaudeMods(version)) return undefined;
  return `Claude Code ${version} 不满足 Orbis 的 Mods 版本要求（最低 ${CLAUDE_MIN_VERSION}）；请运行 claude update 后重新打开会话`;
}

type VersionRunner = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr?: string }>;
const execute = promisify(execFile);

/** Bounded, read-only check of the exact executable the Host will launch. Never return raw CLI diagnostics. */
export async function readClaudeVersion(cli: string, env: NodeJS.ProcessEnv, cwd?: string, run?: VersionRunner): Promise<string> {
  try {
    let output: string;
    if (run) {
      const result = await run(cli, ["--version"], env);
      if (result.code !== 0) throw new Error("version command failed");
      output = `${result.stdout}\n${result.stderr ?? ""}`;
    } else {
      const invocation = agentInvocation({ command: cli, prefixArgs: [] }, ["--version"], env);
      const result = await execute(invocation.command, invocation.args, {
        cwd, env, timeout: 5_000, maxBuffer: 32_768, windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      output = `${result.stdout}\n${result.stderr}`;
    }
    const lines = stripVTControlCharacters(output).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    // A wrapper can announce its own version first. Prefer the native label;
    // an unlabelled output must be exactly one semantic version, not a diagnostic.
    const native = lines.find(line => /^v?\S+\s+\(Claude Code\)$/u.test(line));
    const reported = native ?? (lines.length === 1 && parseAgentVersion(lines[0]!.replace(/^v/u, "")) ? lines[0] : undefined);
    const version = reported ? extractAgentVersion(reported) : undefined;
    if (version && parseAgentVersion(version)) return version;
  } catch { /* A failed or unrecognized probe never proves compatibility. */ }
  throw new Error(`无法读取 Claude Code 版本；Orbis 需要 ${CLAUDE_MIN_VERSION} 或更新版本，请运行 claude --version 检查安装`);
}

export async function requireClaudeModsVersion(cli: string, env: NodeJS.ProcessEnv, cwd?: string, run?: VersionRunner): Promise<void> {
  // CLAUDE-MODS-MIN-02: only a confirmed old version blocks an existing launch
  // path. Discovery shows probe failures; actual hello still validates the TUI.
  let version: string;
  try { version = await readClaudeVersion(cli, env, cwd, run); }
  catch { return; }
  const reason = claudeVersionRequirement(version);
  if (reason) throw new Error(reason);
}
