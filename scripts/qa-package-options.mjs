import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function parseQaPackageOptions(args) {
  let output, activationFile;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--qa-activation-file") {
      if (activationFile || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Supply one QA activation file");
      activationFile = args[++i];
    } else if (arg.startsWith("--") || output) throw new Error("Unknown runtime packaging argument");
    else output = arg;
  }
  return { output, activationFile };
}

/** Validate before packaging starts; neither JSON parser errors nor private input reach build logs. */
export async function loadPackageQaActivation(path, parseActivation) {
  if (!path) return undefined;
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read valid QA activation JSON"); }
  return parseActivation(value);
}

export async function stageQaActivation(output, activation) {
  const target = join(output, "qa-activation.json");
  // Repackaging this directory as a release must not retain a previous QA secret.
  if (!activation) { await rm(target, { force: true }); return; }
  await writeFile(target, JSON.stringify(activation, null, 2) + "\n", { mode: 0o600 });
  await chmod(target, 0o600);
}
