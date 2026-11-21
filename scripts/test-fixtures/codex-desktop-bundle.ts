/**
 * A Codex Desktop bundle laid out like 26.1117 (ADR-0096): the GUI starts its CLI from a helper nested in
 * `Contents/Frameworks/…/Helpers/Codex (Aperitif).app`, and the bundled CLI is declared by
 * `Contents/Resources/codex-cli/codex-package.json`.
 */
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const plist = (identifier: string, executable: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
</dict></plist>
`;

/** fork + exec + wait, passing the exit status through: a stand-in for the GUI and its helper. */
const FORWARDER = `#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  pid_t child = fork();
  if (child == 0) { execv(argv[1], argv + 1); _exit(127); }
  int status = 0;
  if (waitpid(child, &status, 0) < 0) return 1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
`;

export type FakeCodexBundle = {
  app: string;
  helper: string;
  guiExecutable: string;
  helperExecutable: string;
  cliRoot: string;
  /** `bin/codex`, the manifest entry. */
  entry: string;
  /** `CodexCLI.app/Contents/MacOS/codex`, the signed binary in real bundles. */
  binary: string;
  /** Compile real forwarders into the GUI and helper paths (macOS with a C compiler only). */
  compileForwarders(): Promise<boolean>;
  /** Run `command` as a grandchild of the GUI, through the helper, like Codex 26.1117. */
  runThroughDesktop(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
};

export async function fakeCodexBundle(root: string, options: { manifestEntry?: string | null; name?: string } = {}): Promise<FakeCodexBundle> {
  const app = join(root, options.name ?? "ChatGPT.app");
  const helper = join(app, "Contents", "Frameworks", "Codex Framework.framework", "Versions", "158.0.8127.37", "Helpers", "Codex (Aperitif).app");
  const guiExecutable = join(app, "Contents", "MacOS", "ChatGPT");
  const helperExecutable = join(helper, "Contents", "MacOS", "Codex (Aperitif)");
  const cliRoot = join(app, "Contents", "Resources", "codex-cli");
  const entry = join(cliRoot, "bin", "codex");
  const binary = join(cliRoot, "CodexCLI.app", "Contents", "MacOS", "codex");
  for (const path of [guiExecutable, helperExecutable, entry, binary]) await mkdir(dirname(path), { recursive: true });
  await writeFile(join(app, "Contents", "Info.plist"), plist("com.openai.codex", "ChatGPT"));
  await writeFile(join(helper, "Contents", "Info.plist"), plist("com.openai.codex.helper", "Codex (Aperitif)"));
  await writeFile(join(cliRoot, "CodexCLI.app", "Contents", "Info.plist"), plist("com.openai.codex.cli", "codex"));
  const manifestEntry = options.manifestEntry === undefined ? "bin/codex" : options.manifestEntry;
  if (manifestEntry !== null) {
    await writeFile(join(cliRoot, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version: "0.171.0-test", entrypoint: manifestEntry }));
  }
  return {
    app, helper, guiExecutable, helperExecutable, cliRoot, entry, binary,
    async compileForwarders() {
      if (process.platform !== "darwin") return false;
      const source = join(root, "forwarder.c");
      await writeFile(source, FORWARDER);
      try {
        await promisify(execFile)("/usr/bin/cc", ["-O2", "-o", guiExecutable, source], { timeout: 60_000 });
        await promisify(execFile)("/usr/bin/cc", ["-O2", "-o", helperExecutable, source], { timeout: 60_000 });
        return true;
      } catch { return false; }
    },
    runThroughDesktop(command, args, spawnOptions = {}) {
      return spawn(guiExecutable, [helperExecutable, command, ...args], spawnOptions);
    },
  };
}
