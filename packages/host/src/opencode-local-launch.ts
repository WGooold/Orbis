import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkServiceCliVersion, launchLocalService, serviceCli } from "./local-agent-start.js";
import { OPENCODE_CLIENT_VERSION, type OpenCodeLocalLauncher } from "./opencode-service-connection.js";

// OpenCode 2.3.2's stable service uses this file and a fixed per-user service port. Keep that
// native collision check; never substitute a random port, the standalone mode, or SDK ensure/stop.
async function checkServiceConfig(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("无法读取 OpenCode 共享服务配置");
  });
  if (!handle) return;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as Record<string, unknown>;
    if (config.disabled === true || config.remote !== undefined && config.remote !== false ||
        config.hostname !== undefined && config.hostname !== "127.0.0.1") throw new Error();
  } catch { throw new Error("OpenCode 的共享服务已禁用、使用远程配置或配置无效；Orbis 只接入已有服务"); }
  finally { await handle.close(); }
}

export function createOpenCodeLocalLauncher(env: NodeJS.ProcessEnv = process.env): OpenCodeLocalLauncher {
  const cli = serviceCli("opencode", env);
  delete cli.env.OPENCODE_PTY_HANDOFF;
  const configPath = join(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode"), "service.json");
  const find = () => cli.find(OPENCODE_CLIENT_VERSION);
  return {
    available: async () => await checkServiceConfig(configPath).then(find, () => undefined) !== undefined,
    start: async (guard, shouldStart, confirm) => {
      await checkServiceConfig(configPath);
      const entry = await find();
      if (!entry) throw new Error(`未找到兼容的 OpenCode ${OPENCODE_CLIENT_VERSION} CLI`);
      const command = await cli.resolve(entry);
      await checkServiceCliVersion(command, cli.cwd, cli.env, guard.signal, "OpenCode", OPENCODE_CLIENT_VERSION);
      await checkServiceConfig(configPath);
      if (!await shouldStart()) return;
      guard.check();
      await launchLocalService(command, ["serve", "--service", "--hostname", "127.0.0.1"], cli, confirm);
    },
  };
}
