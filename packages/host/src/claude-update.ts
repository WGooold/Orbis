import { agentInvocation } from "./agent-command.js";
import { runAgentInstaller } from "./agent-installation.js";
import { findClaudeExecutable } from "./claude-integration-install.js";
import { readClaudeVersion } from "./claude-version.js";

type UpdateRunner = (cli: string, env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<void>;

// HOST-CLAUDE-UPDATE-01: keep the selected launcher's installer/channel authoritative.
// The native `update` command owns native and package-manager updates; Orbis never
// installs a second npm copy or replaces the user's stable launcher.
const runUpdate: UpdateRunner = async (cli, env, signal) => {
  const invocation = agentInvocation({ command: cli, prefixArgs: [] }, ["update"], env);
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
  run?: UpdateRunner;
}): Promise<{ entry: string; version: string }> {
  const env = input.env ?? process.env;
  input.signal.throwIfAborted();
  const entry = await findClaudeExecutable(env);
  input.signal.throwIfAborted();
  if (!entry) throw new Error("没有找到 Claude Code，请先通过官方安装程序安装");
  input.onStage?.("downloading");
  await (input.run ?? runUpdate)(entry, env, input.signal);
  input.signal.throwIfAborted();
  input.onStage?.("verifying");
  // Exit 0 alone does not prove a usable installation. Read the same stable
  // launcher again, not a different copy or a version parsed from update output.
  const version = await readClaudeVersion(entry, env);
  input.signal.throwIfAborted();
  return { entry, version };
}
