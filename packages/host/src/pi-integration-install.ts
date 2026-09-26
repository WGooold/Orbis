import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readObject(path: string): Promise<JsonObject> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
  if (!isObject(value)) throw new Error(`Expected a JSON object in ${path}`);
  return value;
}

async function writeObject(path: string, value: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function entrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  return isObject(entry) && typeof entry.source === "string" ? entry.source : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) => resolve(path).replaceAll("/", "\\").toLowerCase();
  return normalize(left) === normalize(right);
}

async function isOtherOrbisPackage(entry: unknown, agentDir: string): Promise<boolean> {
  const source = entrySource(entry);
  if (!source || /^(?:npm:|git:|https?:)/u.test(source)) return false;
  const packagePath = isAbsolute(source) ? source : resolve(agentDir, source);
  const root = basename(packagePath).toLowerCase() === "index.js" ? dirname(dirname(packagePath)) : packagePath;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return isObject(manifest) && manifest.name === "@pi-remote/pi-extension";
  } catch {
    return false;
  }
}

export async function updatePiIntegration(input: {
  extensionDir: string;
  agentDir?: string;
  uninstall?: boolean;
}): Promise<void> {
  const extensionDir = resolve(input.extensionDir);
  const agentDir = input.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const settingsPath = join(agentDir, "settings.json");
  const controlPath = join(agentDir, "remote-control.json");
  if (!input.uninstall) {
    const manifest = await readObject(join(extensionDir, "package.json"));
    if (manifest.name !== "@pi-remote/pi-extension") throw new Error("Invalid Orbis Pi extension package");
    await stat(join(extensionDir, "dist", "index.js"));
  }

  // Read and validate both files before replacing either one.
  const settings = await readObject(settingsPath);
  const control = await readObject(controlPath);
  const packages = settings.packages === undefined ? [] : settings.packages;
  if (!Array.isArray(packages)) throw new Error(`Expected a packages array in ${settingsPath}`);
  const kept: unknown[] = [];
  let alreadyRegistered = false;
  for (const entry of packages) {
    const source = entrySource(entry);
    if (source && samePath(isAbsolute(source) ? source : resolve(agentDir, source), extensionDir)) {
      if (!input.uninstall && !alreadyRegistered) {
        kept.push(entry);
        alreadyRegistered = true;
      }
    } else if (!input.uninstall && await isOtherOrbisPackage(entry, agentDir)) {
      // A previous checkout must not be loaded beside the bundled copy.
    } else {
      kept.push(entry);
    }
  }
  if (!input.uninstall && !alreadyRegistered) kept.push(extensionDir);
  if (JSON.stringify(packages) !== JSON.stringify(kept)) await writeObject(settingsPath, { ...settings, packages: kept });

  if (input.uninstall) {
    if (control.orbisLocalEnabled === true) {
      const remaining = { ...control };
      delete remaining.orbisLocalEnabled;
      await writeObject(controlPath, remaining);
    }
  } else if (control.orbisLocalEnabled === undefined) {
    await writeObject(controlPath, { ...control, orbisLocalEnabled: true });
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  const [, , extensionDir, option] = process.argv;
  if (!extensionDir || (option !== undefined && option !== "--uninstall")) {
    console.error("Usage: pi-integration-install <extension-dir> [--uninstall]");
    process.exitCode = 1;
  } else {
    updatePiIntegration({ extensionDir, uninstall: option === "--uninstall" }).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
