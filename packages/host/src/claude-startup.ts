import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claudeWorkspaceTrustRoot } from "./claude-workspace-trust.js";
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN } from "./claude-integration-install.js";

const execute = promisify(execFile);

/** Only read readiness. Never log native account data or manufacture login/consent. */
export async function checkClaudeAuthentication(cli: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  let stdout: string;
  const shim = process.platform === "win32" && cli.toLowerCase().endsWith(".cmd");
  const command = shim ? env.ComSpec ?? "cmd.exe" : cli;
  const args = shim ? ["/d", "/s", "/c", `""${cli}" auth status --json"`] : ["auth", "status", "--json"];
  try { ({ stdout } = await execute(command, args, { cwd, env, timeout: 10_000, maxBuffer: 128 * 1024,
    windowsHide: true, windowsVerbatimArguments: shim })); }
  catch (error) {
    const output = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
    try { if (JSON.parse(output)?.loggedIn === false) throw new Error("Claude 尚未完成账号授权，请先连接供应商账号后重试；未打开等待登录的终端"); }
    catch (parsed) { if (parsed instanceof Error && parsed.message.startsWith("Claude 尚未")) throw parsed; }
    throw new Error("无法核对 Claude 登录状态，请检查原生 CLI 与供应商配置");
  }
  let result: unknown;
  try { result = JSON.parse(stdout); } catch { throw new Error("Claude 登录检查未返回可识别的状态"); }
  if (!object(result) || typeof result.loggedIn !== "boolean") throw new Error("Claude 登录检查未返回可识别的状态");
  if (!result.loggedIn) throw new Error("Claude 尚未完成账号授权，请先连接供应商账号后重试；未打开等待登录的终端");
}

const plugin = `${CLAUDE_PLUGIN}@${CLAUDE_MARKETPLACE}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { const value: unknown = JSON.parse(text); if (object(value)) return value; } catch { /* Report the file, never its potentially private content. */ }
  throw new Error(`Claude 启动配置格式无效：${path}`);
}

/** Snapshot only the selected project's declared servers; no global or future-server approval. */
export async function claudeStartupSettings(input: { cwd: string; configDir: string; env: NodeJS.ProcessEnv; managedSettingsPath?: string; platform?: NodeJS.Platform }): Promise<{ installed: boolean; args: string[] }> {
  for (const name of ["CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"]) {
    if (["1", "true"].includes(input.env[name]?.toLowerCase() ?? "")) throw new Error(`Claude 的 ${name} 禁用了 Orbis 插件，无法启动连接`);
  }
  const layers: Record<string, unknown>[] = [];
  const user = await jsonFile(join(input.configDir, "settings.json"));
  if (user) layers.push(user);
  const directory = resolve(input.cwd);
  const servers = new Set<string>();
  for (const path of [directory]) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const settings = await jsonFile(join(path, ".claude", name));
      if (settings) layers.push(settings);
    }
    const mcp = await jsonFile(join(path, ".mcp.json"));
    if (mcp !== undefined) {
      if (!object(mcp.mcpServers)) throw new Error(`Claude MCP 配置缺少 mcpServers：${join(path, ".mcp.json")}`);
      for (const name of Object.keys(mcp.mcpServers)) servers.add(name);
    }
  }
  // Shared project settings are cwd-scoped; on POSIX Claude also reads the
  // main checkout's local settings (which win over legacy cwd-local settings).
  if ((input.platform ?? process.platform) !== "win32") {
    const root = await claudeWorkspaceTrustRoot(directory, input.env);
    if (root !== directory) {
      const local = await jsonFile(join(root, ".claude", "settings.local.json"));
      if (local) layers.push(local);
    }
  }
  const managed = input.managedSettingsPath ? await jsonFile(input.managedSettingsPath) : undefined;
  if (managed) {
    layers.push(managed);
    const configs = object(managed.pluginConfigs) ? managed.pluginConfigs : {};
    const guard = object(configs["cc-plugin-sec-default@builtin"]) ? configs["cc-plugin-sec-default@builtin"] : {};
    if (object(guard.options) && guard.options.allowManagedModsOnly === true) {
      throw new Error("Claude 管理策略仅允许运行受管理的 Mods，无法确认 Orbis 插件获准连接");
    }
    const forceEnabled = object(managed.enabledPlugins) && managed.enabledPlugins[plugin] === true;
    if (managed.allowManagedHooksOnly === true && !forceEnabled) {
      throw new Error("Claude 管理策略仅允许运行受管理的 Hooks，Orbis 插件未被管理设置启用");
    }
  }
  let enabled: boolean | undefined;
  let disabledHooks = false;
  const denied = new Set<string>();
  for (const layer of layers) {
    if (typeof layer.disableAllHooks === "boolean") disabledHooks = layer.disableAllHooks;
    if (object(layer.enabledPlugins) && Object.hasOwn(layer.enabledPlugins, plugin)) {
      if (typeof layer.enabledPlugins[plugin] === "boolean") enabled = layer.enabledPlugins[plugin];
    }
    if (Array.isArray(layer.disabledMcpjsonServers)) for (const name of layer.disabledMcpjsonServers) if (typeof name === "string") denied.add(name);
  }
  if (enabled === false) throw new Error("Orbis Claude 插件已被明确禁用，请先在设置中启用连接");
  if (disabledHooks) throw new Error("Claude 的 disableAllHooks 禁用了 Orbis 插件，无法启动连接");
  const approved = [...servers].filter(name => !denied.has(name)).sort();
  return { installed: enabled === true, args: approved.length === 0 ? [] : ["--settings", JSON.stringify({ enabledMcpjsonServers: approved })] };
}

export function claudeManagedSettingsPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json");
  return "/etc/claude-code/managed-settings.json";
}
