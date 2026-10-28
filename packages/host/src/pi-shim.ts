/**
 * Windows `pi.cmd`（见 pi-command.ts）的落点：在同一个进程里运行 Orbis Host 当前激活的 Pi。
 *
 * 不再起子进程：Ctrl+C、退出码和终端尺寸都直接属于 Pi 自己。每次都重新读安装记录，所以 Pi
 * 升级或切换版本后 `pi.cmd` 不需要重新生成。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { agentInstallRoot } from "./agent-root.js";

export function activePiEntry(root: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(join(root, "pi", "installations.json"), "utf8")) as { installations?: Array<{ active?: unknown; entry?: unknown }> };
    const active = data.installations?.find(item => item?.active === true);
    return typeof active?.entry === "string" && existsSync(active.entry) ? active.entry : undefined;
  } catch {
    return undefined;
  }
}

export async function main(args: readonly string[]): Promise<void> {
  const root = process.env.ORBIS_PI_COMMAND_ROOT?.trim() || agentInstallRoot();
  const entry = activePiEntry(root);
  if (entry === undefined) {
    process.stderr.write("pi: Orbis Host 里没有可用的 Pi。请在 Orbis Host 的 Agent 页安装 Pi。\n");
    process.exit(127);
  }
  // Pi 读 process.argv.slice(2)：让它看起来就像被 `node <entry> ...` 直接启动。
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
