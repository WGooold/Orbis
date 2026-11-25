import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, parse } from "node:path";

const name = "orbis-opencode-tabs";
const entry = "tui.js";
const manifest = '{"name":"orbis-opencode-tabs","private":true,"type":"module"}\n';
const header = "// Managed by Orbis: OpenCode TUI session tabs\n";
const conflict = () => new Error("OpenCode 扩展目录已有非 Orbis 内容，未修改任何扩展");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function pluginPath(env: NodeJS.ProcessEnv) {
  const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const config = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  if (!isAbsolute(config) || normalize(config) === parse(config).root || /[\0\r\n]/u.test(config))
    throw new Error("OpenCode 配置目录必须是有效的绝对路径");
  const plugins = join(config, "plugins");
  return { plugins, directory: join(plugins, name) };
}

async function managedEntry(directory: string): Promise<string | undefined> {
  const info = await lstat(directory).catch(error => { if (!missing(error)) throw error; });
  if (!info) return undefined;
  if (!info.isDirectory()) throw conflict();
  const files = await readdir(directory);
  if (!files.includes("package.json") || files.some(file => file !== "package.json" && file !== entry)) throw conflict();
  const packageFile = join(directory, "package.json");
  if (!(await lstat(packageFile)).isFile() || await readFile(packageFile, "utf8") !== manifest) throw conflict();
  if (!files.includes(entry)) return undefined;
  const path = join(directory, entry);
  if (!(await lstat(path)).isFile()) throw conflict();
  const code = await readFile(path, "utf8");
  if (!code.startsWith(header)) throw conflict();
  return code;
}

export async function openCodeTuiTabsInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await managedEntry(pluginPath(env).directory)) !== undefined;
}

/** Explicit desktop opt-in. Leave user-supplied settings, other plugins, and the service untouched. */
export async function configureOpenCodeTuiTabs(enabled: boolean, requireCurrent: () => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireCurrent();
  const { plugins, directory } = pluginPath(env);
  const installed = await managedEntry(directory);
  const target = join(directory, entry);
  if (!enabled) {
    if (installed !== undefined) { requireCurrent(); await unlink(target); }
    return;
  }
  const code = header + await readFile(new URL("./opencode-tui-tabs-plugin.js", import.meta.url), "utf8");
  if (installed === code) return;
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  requireCurrent();
  if (await mkdir(directory, { mode: 0o700 }).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  })) await writeFile(join(directory, "package.json"), manifest, { mode: 0o600, flag: "wx" });

  // Only complete source files reach OpenCode's watcher. Temporary regular files in
  // the plugins parent are ignored by OpenCode's directory-only discovery.
  const temporary = join(plugins, `.${name}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, code, { mode: 0o600, flag: "wx" });
    if (await managedEntry(directory) !== installed) throw conflict();
    requireCurrent();
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
