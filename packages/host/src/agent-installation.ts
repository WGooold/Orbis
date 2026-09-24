import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AgentKind } from "@pi-remote/protocol";
import { agentKind } from "./provider-manager.js";

const execute = promisify(execFile);
export const agentPackages = { pi: "@earendil-works/pi-coding-agent", codex: "@openai/codex", dsh: "@deepseek-ai/dsh" } as const;
export function installPackage(kind: string, version: string): string {
  agentKind(kind);
  if (!/^(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(version)) throw new Error("版本应为 latest 或完整版本号，例如 0.1.7-rc.1");
  return `${agentPackages[kind as AgentKind]}@${version}`;
}
/** Fresh directories make updates reversible and avoid Windows locks on running CLI binaries. */
export async function installAgentPackage(kind: AgentKind, version: string, root: string, signal: AbortSignal): Promise<{ entry: string; version: string }> {
  const spec = installPackage(kind, version);
  const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  await access(npm);
  const destination = join(root, kind, randomUUID());
  await mkdir(destination, { recursive: true });
  try {
    await execute(process.execPath, [npm, "install", "--prefix", destination, "--no-audit", "--no-fund", "--", spec], {
      signal, timeout: 600_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    const packageRoot = join(destination, "node_modules", agentPackages[kind]);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string; bin: string | Record<string, string> };
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[kind];
    if (typeof bin !== "string") throw new Error("缺少 CLI 入口");
    const entry = resolve(packageRoot, bin);
    if (!entry.startsWith(resolve(packageRoot) + sep) || !/\.(?:m?js|cjs)$/.test(entry)) throw new Error("CLI 入口格式不受支持");
    await access(entry);
    await execute(process.execPath, [entry, "--version"], { timeout: 15_000, windowsHide: true, maxBuffer: 64_000 });
    return { entry, version: manifest.version };
  } catch (error) {
    if (signal.aborted) throw new Error("安装已取消；原有 Agent 保持可用");
    // npm output can contain registry tokens or credentials from proxy configuration.
    throw new Error("Agent 下载或版本验证失败；原有安装保持可用。请检查网络、npm 源及版本号。", { cause: error });
  }
}
