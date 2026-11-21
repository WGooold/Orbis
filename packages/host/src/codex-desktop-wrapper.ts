/**
 * Codex Desktop wrapper entry (ADR-0022, ADR-0096). Codex runs this as its CLI through
 * `CODEX_CLI_PATH`; the work happens in codex-desktop-invocation.ts.
 *
 * This file imports only Node built-ins and loads the implementation lazily, so a broken or
 * half-updated Orbis install cannot stop Codex from starting: on macOS the invocation then runs on the
 * Desktop's own CLI, and the reason reaches Codex's error line and the Host.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { nativeLauncher, runWithoutOrbis } from "./codex-desktop-native-fallback.js";

type Main = typeof import("./codex-desktop-invocation.js").main;

function say(line: string): void {
  try { process.stderr.write(`[orbis-codex-wrapper] ${line}\n`); } catch { /* Codex closed the pipe. */ }
}

let stdioGuarded = false;

export async function main(...args: Parameters<Main>): Promise<void> {
  if (!stdioGuarded) {
    // Codex may close our pipes first; a late write error must never crash past cleanup.
    for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
    stdioGuarded = true;
  }
  let run: Main;
  try { run = (await import("./codex-desktop-invocation.js")).main; }
  catch (error) {
    const [argv, env = process.env] = args;
    const cause = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 160);
    const launcher = nativeLauncher(env);
    if (launcher !== undefined) say(`Orbis 包装器无法加载（${cause}），本次以 Codex 自带 CLI 运行，未接入 Orbis。请重新安装 Orbis Host。`);
    const code = launcher === undefined ? undefined : await runWithoutOrbis(launcher, argv, env);
    if (code !== undefined) {
      process.exitCode = code;
      return;
    }
    // Desktop shows the last stderr line: the next step goes there.
    say(`Orbis 包装器无法加载（${cause}）。请重新安装 Orbis Host；需要立即使用 Codex 时，请完全退出 Codex 后从程序坞或开始菜单重新打开。`);
    process.exitCode = 127;
    return;
  }
  await run(...args);
}

/** True when this module is the process entry, also through symlinked install paths. */
function isEntry(url: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(url)); }
  catch { return false; }
}

if (isEntry(import.meta.url)) {
  await main(process.argv.slice(2));
  // Nothing should keep the wrapper alive after its session; never linger as a hidden process.
  setTimeout(() => process.exit(), 3_000).unref();
}
