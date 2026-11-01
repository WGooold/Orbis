import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasCode = (error: unknown, code: string): boolean => isObject(error) && error.code === code;

/** Match the config used by the launched TUI, including an explicit non-default config directory. */
export function claudeLaunchConfig(configDir: string, env: NodeJS.ProcessEnv, home = homedir()): { file: string; directory?: string } {
  const directory = resolve(configDir);
  const explicitlyConfigured = !!env.CLAUDE_CONFIG_DIR && resolve(env.CLAUDE_CONFIG_DIR) === directory;
  return explicitlyConfigured || directory !== resolve(home, ".claude")
    ? { file: join(directory, ".claude.json"), directory }
    : { file: join(home, ".claude.json") };
}

/** Claude keys repository trust on the main checkout, including launches in linked worktrees. */
export async function claudeWorkspaceTrustRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("Claude 工作区必须是绝对路径");
  const directory = await realpath(cwd);
  if (!(await stat(directory)).isDirectory()) throw new Error("Claude 工作区不是目录");
  // An inherited GIT_DIR/GIT_WORK_TREE must not authorize an unrelated checkout.
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const options = { cwd: directory, env: { ...gitEnv, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8" as const, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true };
  try {
    await execFileAsync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], options);
    const worktrees = await execFileAsync("git", ["-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"], options);
    const first = worktrees.stdout.split("\0")[0];
    if (!first?.startsWith("worktree ")) throw new Error("无法确定 Claude 工作区的 Git 主目录");
    return await realpath(first.slice("worktree ".length));
  } catch (error) {
    if (isObject(error) && typeof error.stderr === "string" && error.stderr.startsWith("fatal: not a git repository")) return directory;
    throw new Error("无法确定 Claude 工作区的信任范围", { cause: error });
  }
}

async function readConfig(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
}

/**
 * Only call for a user-requested launch. The selected workspace is the authorization scope.
 * Documented by Claude's permissions guide; this does not change tool or MCP approvals.
 * Serialize Orbis writers and detect concurrent native edits before replacing the file.
 */
export async function trustClaudeWorkspace(input: { cwd: string; configFile: string; env?: NodeJS.ProcessEnv; home?: string }): Promise<string> {
  const root = await claudeWorkspaceTrustRoot(input.cwd, input.env);
  const home = await realpath(input.home ?? homedir());
  if (root === home || dirname(root) === root) throw new Error("请为 Claude 选择具体项目目录，不能持久信任整个主目录或磁盘根目录");
  await mkdir(dirname(input.configFile), { recursive: true, mode: 0o700 });
  // Follow an existing config symlink rather than replacing it.
  const file = await realpath(input.configFile).catch(error => { if (hasCode(error, "ENOENT")) return input.configFile; throw error; });
  const lockPath = `${file}.orbis-trust.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { lock = await open(lockPath, "wx", 0o600); break; }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; await delay(50); }
  }
  if (lock === undefined) throw new Error("Claude 项目信任配置正被占用，请重试打开会话");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await readConfig(file);
      let config: unknown;
      try { config = before === undefined ? {} : JSON.parse(before); }
      catch { throw new Error("Claude 配置不是有效 JSON，未修改项目信任记录"); }
      if (!isObject(config) || (config.projects !== undefined && !isObject(config.projects))) {
        throw new Error("Claude 项目配置格式无效，未修改项目信任记录");
      }
      const projects = (config.projects ?? {}) as Record<string, unknown>;
      const previous = Object.hasOwn(projects, root) ? projects[root] : undefined;
      if (previous !== undefined && !isObject(previous)) throw new Error("Claude 项目信任记录格式无效");
      if (isObject(previous) && previous.hasTrustDialogAccepted === true) return root;
      const updated = { ...config, projects: { ...projects, [root]: { ...(previous ?? {}), hasTrustDialogAccepted: true } } };
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const output = await open(temporary, "wx", 0o600);
        try { await output.writeFile(`${JSON.stringify(updated, null, 2)}\n`); await output.sync(); }
        finally { await output.close(); }
        if (await readConfig(file) !== before) continue;
        await rename(temporary, file);
        return root;
      } finally { await rm(temporary, { force: true }); }
    }
    throw new Error("Claude 配置持续被其他进程修改，请重试打开会话");
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
