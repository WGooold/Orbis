import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { PROTOCOL_VERSION } from "@pi-remote/protocol";

const execFileAsync = promisify(execFile);

/** Host-owned query carried inside E2E, like LAN discovery and path preferences. */
export type GitBranchRequest = {
  type: "runtime.git.request";
  protocolVersion: number;
  runtimeId: string;
  requestId: string;
};

export function parseGitBranchRequest(value: unknown): GitBranchRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== "runtime.git.request" || message.protocolVersion !== PROTOCOL_VERSION) return undefined;
  if (Object.keys(message).some((key) => !["type", "protocolVersion", "runtimeId", "requestId"].includes(key))) return undefined;
  const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 128;
  if (!validId(message.runtimeId) || !validId(message.requestId)) return undefined;
  return { type: message.type, protocolVersion: PROTOCOL_VERSION, runtimeId: message.runtimeId, requestId: message.requestId };
}

/** The registered runtime's cwd is authoritative, including linked worktrees and unborn branches. */
export async function readGitBranch(cwd: string): Promise<{ branch: string | null; commit: string | null }> {
  // An inherited Git environment must not silently redirect this read to the Host's own repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const options = { cwd, env, windowsHide: true, timeout: 2_000, maxBuffer: 8_192 };
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
    const branch = stdout.trim();
    return { branch: branch.length > 0 && branch.length <= 256 ? branch : null, commit: null };
  } catch {
    // Detached HEAD still has a useful identity. A missing Git executable/repository or timeout
    // returns no identity; none of these conditions should block the conversation or show a modal.
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--short=8", "HEAD"], options);
      const commit = stdout.trim();
      return { branch: null, commit: /^[a-f0-9]{8,64}$/u.test(commit) ? commit : null };
    } catch {
      return { branch: null, commit: null };
    }
  }
}
