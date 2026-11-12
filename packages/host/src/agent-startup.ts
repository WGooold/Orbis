import { homedir } from "node:os";
import { isAbsolute, normalize, parse, win32 } from "node:path";

/** ADR-0073: Host manages updates separately; these overrides last for one process. */
export const CODEX_STARTUP_ARGS = ["-c", "check_for_update_on_startup=false"] as const;
export const PI_STARTUP_ENV = { PI_SKIP_VERSION_CHECK: "1" } as const;
export const CLAUDE_STARTUP_ENV = { DISABLE_AUTOUPDATER: "1" } as const;

/** ADR-0056: a user-requested launch authorizes exactly this workspace's resources. */
export const PI_WORKSPACE_APPROVAL_ARGS = ["--approve"] as const;

/** Keys use the same quoted dotted-path syntax as Codex's native config writer. */
export function codexWorkspaceTrustKey(cwd: string): string {
  const windows = /^[a-z]:[\\/]/iu.test(cwd) || cwd.startsWith("\\\\");
  const paths = windows ? win32 : { isAbsolute, normalize, parse };
  const normalized = paths.normalize(cwd);
  if (!paths.isAbsolute(cwd) || [...cwd].some(character => character.charCodeAt(0) < 32) || normalized === paths.normalize(homedir()) || paths.parse(normalized).root === normalized) {
    throw new Error("请为 Agent 选择具体项目的绝对路径");
  }
  return `projects.${JSON.stringify(cwd)}.trust_level`;
}

export function codexWorkspaceApprovalArgs(cwd: string): string[] {
  return ["-c", `${codexWorkspaceTrustKey(cwd)}="trusted"`];
}

export type StartupConfigClient = { request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> };
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Write through the serving backend so custom CODEX_HOME and remote config are respected. */
export async function prepareCodexWorkspace(client: StartupConfigClient, cwd: string): Promise<void> {
  const keyPath = codexWorkspaceTrustKey(cwd);
  const current = object(await client.request("config/read", { cwd, includeLayers: false }, 5000));
  const projects = object(object(current.config).projects);
  if (object(projects[cwd]).trust_level === "trusted") return;
  const written = object(await client.request("config/batchWrite", {
    edits: [{ keyPath, value: "trusted", mergeStrategy: "replace" }], reloadUserConfig: true,
  }, 5000));
  if (written.status !== "ok") throw new Error("Codex 项目授权未生效，配置可能受管理策略限制");
}
