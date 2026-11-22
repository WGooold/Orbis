/**
 * Last resort on macOS when the wrapper cannot run an invocation itself (ADR-0096): run the generated
 * launcher in native mode. It executes the launching Desktop's own CLI exactly as Codex would without
 * Orbis, found with the same rule as the wrapper. Valid only before any CLI was started for this
 * invocation, so nothing is replayed. Node built-ins only: this must load even when Orbis cannot.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export const LAUNCHER_NATIVE_MODE = "ORBIS_CODEX_LAUNCHER_NATIVE";
const SIGNAL_EXIT: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** The Orbis launcher Codex ran us through, when it can run natively. */
export function nativeLauncher(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  const launcher = env.CODEX_CLI_PATH?.trim();
  if (platform !== "darwin" || !launcher || env[LAUNCHER_NATIVE_MODE] === "1") return undefined;
  return basename(launcher) === "codex-launcher" && existsSync(launcher) ? launcher : undefined;
}

/** Resolves the native CLI's exit status, or undefined when it could not be started at all. */
export async function runWithoutOrbis(launcher: string, argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number | undefined> {
  const child = spawn(launcher, argv, { stdio: "inherit", env: { ...env, [LAUNCHER_NATIVE_MODE]: "1" } });
  const started = await new Promise<boolean>(resolve => { child.once("spawn", () => resolve(true)); child.once("error", () => resolve(false)); });
  if (!started) return undefined;
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals): void => { try { child.kill(signal); } catch { /* exited */ } };
  const exitHook = (): void => { try { child.kill("SIGKILL"); } catch { /* exited */ } };
  for (const signal of signals) process.on(signal, forward);
  process.on("exit", exitHook);
  try {
    return await new Promise<number>(resolve => child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : SIGNAL_EXIT[signal] ?? 137))));
  } finally {
    for (const signal of signals) process.off(signal, forward);
    process.off("exit", exitHook);
  }
}
