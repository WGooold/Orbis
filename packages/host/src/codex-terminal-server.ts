import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { agentInstallRoot } from "./agent-root.js";
import { extractAgentVersion, parseAgentVersion } from "./agent-installation.js";
import { codexTerminalEnvironment } from "./codex-terminal-environment.js";

export type CodexTerminalServerCommand = { command: string; prefixArgs: readonly string[] };
export type CodexTerminalServerOptions = {
  root?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (line: string) => void;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  run?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

const execute = promisify(execFile);
const preparing = new Map<string, Promise<{ command: string; prefixArgs: string[] }>>();
type Run = NonNullable<CodexTerminalServerOptions["run"]>;
const run: Run = (command, args) => execute(command, args, {
  timeout: 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: codexTerminalEnvironment(),
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The ordinary `codex app-server` entry fixes source=vscode. Only the version-matched
 * standalone package can select source=cli without rewriting native history. */
export async function resolveCodexTerminalServer(cli: CodexTerminalServerCommand,
  options: CodexTerminalServerOptions = {}): Promise<{ command: string; prefixArgs: string[] }> {
  const executeCommand = options.run ?? run;
  const output = await executeCommand(cli.command, [...cli.prefixArgs, "--version"]);
  const version = extractAgentVersion(`${output.stdout}\n${output.stderr}`);
  if (!version || !parseAgentVersion(version)) throw new Error("无法确认所选 Codex 版本，不能准备终端服务包");
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const architecture = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  const system = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-musl"
    : platform === "win32" ? "pc-windows-msvc" : undefined;
  if (!architecture || !system) throw new Error(`Codex 终端服务包不支持 ${platform}/${arch}`);
  const target = `${architecture}-${system}`;
  const destination = resolve(options.root ?? agentInstallRoot(), "codex-terminal-server", version, target);
  const pending = preparing.get(destination);
  if (pending) return pending;
  const preparation = prepare(destination, version, target, platform, executeCommand, options);
  preparing.set(destination, preparation);
  try { return await preparation; }
  finally { if (preparing.get(destination) === preparation) preparing.delete(destination); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function validate(directory: string, version: string, target: string, platform: NodeJS.Platform,
  executeCommand: Run): Promise<{ command: string; prefixArgs: string[] }> {
  try {
    const suffix = platform === "win32" ? ".exe" : "";
    const entrypoint = `bin/codex-app-server${suffix}`;
    const execServer = `bin/codex-exec-server${suffix}`;
    const metadata = object(JSON.parse(await readFile(join(directory, "codex-package.json"), "utf8")));
    if (metadata.layoutVersion !== 1 || metadata.version !== version || metadata.target !== target
      || metadata.variant !== "codex-app-server" || metadata.entrypoint !== entrypoint || metadata.execServer !== execServer
      || metadata.pathDir !== "codex-path" || metadata.resourcesDir !== "codex-resources") throw new Error("清单身份不匹配");
    for (const path of [directory, ...["bin", "codex-path", "codex-resources"].map(name => join(directory, name))]) {
      if (!(await lstat(path)).isDirectory()) throw new Error("包目录不完整");
    }
    const required = ["codex-package.json", entrypoint, execServer, `bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`,
      ...(platform === "linux" ? ["codex-resources/bwrap"] : platform === "win32"
        ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : [])];
    for (const file of required) {
      const stat = await lstat(join(directory, file));
      if (!stat.isFile() || stat.size === 0) throw new Error(`缺少完整配套文件：${file}`);
    }
    const command = join(directory, entrypoint);
    const actual = await executeCommand(command, ["--version"]);
    if (extractAgentVersion(`${actual.stdout}\n${actual.stderr}`) !== version) throw new Error("实际版本不匹配");
    const help = await executeCommand(command, ["--help"]);
    if (!/(?:^|\s)--session-source(?:\s|[=,]|$)/m.test(`${help.stdout}\n${help.stderr}`)) throw new Error("缺少 --session-source 支持");
    return { command, prefixArgs: [] };
  } catch (error) {
    throw new Error(`Codex ${version} 终端服务包校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function prepare(destination: string, version: string, target: string, platform: NodeJS.Platform,
  executeCommand: Run, options: CodexTerminalServerOptions): Promise<{ command: string; prefixArgs: string[] }> {
  // Existing cache is never deleted or repaired in place: it may be in use by another Host.
  if (await exists(destination)) return validate(destination, version, target, platform, executeCommand);
  options.log?.(`正在准备 Codex ${version} 终端服务包（${target}）`);
  const fetchResponse = options.fetch ?? fetch;
  const tag = `rust-v${version}`;
  const assetName = `codex-app-server-package-${target}.tar.gz`;
  const assetUrl = `https://github.com/openai/codex/releases/download/${tag}/${assetName}`;
  const response = await fetchResponse(`https://api.github.com/repos/openai/codex/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "orbis-host" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Codex ${version} 官方终端发布包不可用（HTTP ${response.status}）`);
  const release = object(await response.json());
  const matches = (Array.isArray(release.assets) ? release.assets : []).map(object).filter(asset => asset.name === assetName);
  const asset = matches[0];
  if (release.tag_name !== tag || matches.length !== 1 || !asset || asset.browser_download_url !== assetUrl
    || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)
    || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 * 1024) {
    throw new Error(`Codex ${version} 官方终端发布包缺少匹配的版本、平台或校验信息`);
  }
  const expectedSize = asset.size;
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(`${destination}.tmp-`);
  try {
    const archive = join(temporary, "package.tar.gz");
    const download = await fetchResponse(assetUrl, { signal: AbortSignal.timeout(180_000) });
    if (!download.ok || !download.body) throw new Error(`Codex ${version} 终端服务包下载失败（HTTP ${download.status}）`);
    const digest = createHash("sha256"); let bytes = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > expectedSize) { done(new Error("Codex 终端服务包完整性校验失败：下载体积超出发布值")); return; }
      digest.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream<Uint8Array>), meter,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    if (bytes !== asset.size || `sha256:${digest.digest("hex")}` !== asset.digest) throw new Error("Codex 终端服务包完整性校验失败");
    const listing = await executeCommand("tar", ["-tzf", archive]);
    const names = listing.stdout.split(/\r?\n/u).filter(Boolean);
    if (names.length === 0 || names.some(name => name.startsWith("/") || /^[A-Za-z]:/u.test(name)
      || name.split(/[\\/]/u).includes(".."))) throw new Error("Codex 终端服务包包含无效路径");
    const unpacked = join(temporary, "unpacked"); await mkdir(unpacked);
    await executeCommand("tar", ["-xzf", archive, "-C", unpacked]);
    await validate(unpacked, version, target, platform, executeCommand);
    try { await rename(unpacked, destination); }
    catch (error) {
      // A separate Host may win publication. Verify its complete directory and keep it.
      if (!(await exists(destination))) throw error;
      return validate(destination, version, target, platform, executeCommand);
    }
    options.log?.(`Codex ${version} 终端服务包已就绪`);
    return { command: join(destination, "bin", `codex-app-server${platform === "win32" ? ".exe" : ""}`), prefixArgs: [] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
