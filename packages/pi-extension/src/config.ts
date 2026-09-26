import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface LoadRemoteControlConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
}

type ConfigFile = {
  enabled?: unknown;
  orbisLocalEnabled?: unknown;
  relayUrl?: unknown;
  runtimeCredential?: unknown;
};

const isSecureRelayUrl = (value: string): boolean => {
  const url = new URL(value);
  if (url.protocol === "wss:") return true;
  return url.protocol === "ws:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
};

/** Loads user-level configuration. Project files cannot silently enable remote control. */
export async function loadRemoteControlConfig(
  options: LoadRemoteControlConfigOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  let config: ConfigFile = {};
  try {
    const rawConfig = await readFile(
      options.configPath ?? join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "remote-control.json"),
      "utf8",
    );
    config = JSON.parse(rawConfig.replace(/^\uFEFF/, "")) as ConfigFile;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  // The installer enables only the local Host channel. An explicit user disable wins
  // for standalone Pi, while Host-launched Pi can still opt in for that process.
  if (env.PI_REMOTE_ENABLED !== "true" && config.orbisLocalEnabled === true && config.enabled !== false) return true;

  const enabled = env.PI_REMOTE_ENABLED === "true" || config.enabled === true;
  if (!enabled) return false;

  // Legacy Relay fields are only validated when this older opt-in path is used.
  const relayUrl = env.PI_REMOTE_RELAY_URL ?? config.relayUrl;
  const credential = env.PI_REMOTE_RUNTIME_CREDENTIAL ?? config.runtimeCredential;
  if (typeof relayUrl !== "string" || !relayUrl) throw new Error("Remote control relayUrl is required");
  if (!isSecureRelayUrl(relayUrl)) throw new Error("Public Relay URLs must use wss:// encrypted transport");
  if (typeof credential !== "string" || !credential) throw new Error("Remote control runtimeCredential is required");

  return true;
}
