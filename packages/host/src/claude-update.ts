import { claudeCommandForEntry, agentInvocation } from "./agent-command.js";
import { compareAgentVersions, parseAgentVersion, runAgentInstaller } from "./agent-installation.js";
import { findClaudeExecutable } from "./claude-integration-install.js";
import { readClaudeVersion } from "./claude-version.js";

type UpdateRunner = (cli: string, env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<void>;

// HOST-CLAUDE-UPDATE-02: use the same latest pointer as Anthropic's install.sh,
// independent of npm mirrors and the user's delayed stable update channel.
export async function fetchClaudeLatestVersion(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch("https://downloads.claude.ai/claude-code-releases/latest", {
      headers: { accept: "text/plain", "user-agent": "orbis-host" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const version = (await response.text()).trim();
    return parseAgentVersion(version) ? version : undefined;
  } catch { return undefined; }
}

// Keep the selected launcher and its installation owner. Override only this
// invocation's update channel; never rewrite settings or create a second copy.
const runUpdate: UpdateRunner = async (cli, env, signal) => {
  const invocation = agentInvocation(await claudeCommandForEntry(cli, env), ["--settings", '{"autoUpdatesChannel":"latest"}', "update"], env);
  try {
    await runAgentInstaller(invocation.command, invocation.args, {
      env, signal, timeout: 10 * 60_000,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    // Installer output can include proxy/registry credentials. Classify it,
    // without copying raw diagnostics into the desktop or shared logs.
    const detail = [failure.message, failure.stdout, failure.stderr].join(" ");
    if (/超时|timed?\s*out/iu.test(detail)) throw new Error("Claude Code 更新超时，请稍后重试");
    if (/EACCES|EPERM|EBUSY|permission denied/iu.test(detail)) throw new Error("Claude Code 安装目录不可写或文件被占用，请关闭相关终端后通过原安装器更新");
    throw new Error("Claude Code 更新失败，请运行 claude update 检查原安装渠道、网络与代理");
  }
};

export async function updateClaudeCode(input: {
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStage?: (stage: "downloading" | "verifying") => void;
  onLatest?: (version: string) => void;
  run?: UpdateRunner;
}): Promise<{ entry: string; version: string }> {
  const env = input.env ?? process.env;
  input.signal.throwIfAborted();
  const entry = await findClaudeExecutable(env);
  input.signal.throwIfAborted();
  if (!entry) throw new Error("没有找到 Claude Code，请先通过官方安装程序安装");
  const latest = await fetchClaudeLatestVersion(input.signal);
  input.signal.throwIfAborted();
  if (!latest) throw new Error("Claude Code 最新版本查询失败，请检查网络后重试");
  input.onLatest?.(latest);
  const current = await readClaudeVersion(entry, env).catch(() => undefined);
  input.signal.throwIfAborted();
  if (current && (compareAgentVersions(current, latest) ?? -1) >= 0) return { entry, version: current };
  input.onStage?.("downloading");
  await (input.run ?? runUpdate)(entry, env, input.signal);
  input.signal.throwIfAborted();
  input.onStage?.("verifying");
  // Exit 0 alone does not prove a usable installation. Read the same stable
  // launcher again, not a different copy or a version parsed from update output.
  const version = await readClaudeVersion(entry, env);
  input.signal.throwIfAborted();
  if ((compareAgentVersions(version, latest) ?? -1) < 0) {
    throw new Error(`Claude Code 更新后仍为 ${version}，最新版本为 ${latest}；请检查原安装渠道是否已提供最新版本，或通过原安装器更新`);
  }
  return { entry, version };
}
