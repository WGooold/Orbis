import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/**
 * Orbis Host 自己安装的 Agent 放在哪：各平台存放应用数据的标准位置。
 *
 * - Windows：`%LOCALAPPDATA%\Orbis\agents`
 * - macOS：`~/Library/Application Support/Orbis/agents`（与包装器、pi 命令同一个 Orbis 目录，不在主目录里多出一个文件夹）
 * - 其他：`$XDG_DATA_HOME/Orbis/agents`，缺省 `~/.local/share/Orbis/agents`
 */
export function agentInstallRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const explicit = env.ORBIS_AGENT_INSTALL_ROOT?.trim();
  if (explicit) return explicit;
  const { join } = platform === "win32" ? win32 : posix;
  if (platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "Orbis", "agents");
  if (platform === "darwin") return join(home, "Library", "Application Support", "Orbis", "agents");
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "Orbis", "agents");
}
