import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseQaActivation, type QaActivation } from "@orbis/protocol";
import type { RelayServerOptions } from "./index.js";

export async function readQaActivation(path: string): Promise<QaActivation> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { throw new Error("Cannot read QA activation file"); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid QA activation JSON"); }
  return parseQaActivation(value);
}

/** Explicit QA startup never inherits production Relay state, mail, APNs or administrator credentials. */
export async function qaRelayOptions(args: readonly string[], env: NodeJS.ProcessEnv, packageRoot: string): Promise<RelayServerOptions | undefined> {
  let activationFile = env.ORBIS_QA_ACTIVATION_FILE;
  let dataDir = env.ORBIS_QA_DATA_DIR;
  let packaged = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--qa-package") { packaged = true; continue; }
    if (arg === "--qa-activation-file" || arg === "--qa-data-dir") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing QA option value");
      if (arg === "--qa-activation-file") activationFile = value; else dataDir = value;
      continue;
    }
    throw new Error("Unknown Relay option");
  }
  if (packaged && activationFile) throw new Error("Choose one QA activation file");
  if (packaged) activationFile = join(packageRoot, "qa-activation.json");
  if (!activationFile) {
    if (dataDir) throw new Error("QA data directory requires QA activation");
    return undefined;
  }
  const activation = await readQaActivation(activationFile);
  const directory = resolve(dataDir || join(homedir(), ".orbis", "qa", activation.environmentId, "relay"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid QA Relay port");
  const adminToken = env.ORBIS_QA_ADMIN_TOKEN;
  if (adminToken === activation.credential) throw new Error("QA administrator token must differ from activation credential");
  return {
    port, host: "127.0.0.1", runtimeCredentials: [activation.credential], qaPairingCredential: activation.credential,
    stateFile: join(directory, "relay-state.json"),
    ...(adminToken ? { adminToken } : {}),
  };
}
