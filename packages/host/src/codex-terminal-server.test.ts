import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexTerminalServer, type CodexTerminalServerOptions } from "./codex-terminal-server.js";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const cli = { command: "/selected/node", prefixArgs: ["/selected/codex.js"] };

async function fixture(platform: NodeJS.Platform = "darwin", arch = "arm64") {
  const root = await mkdtemp(join(tmpdir(), "orbis-terminal-server-")); roots.push(root);
  const architecture = arch === "arm64" ? "aarch64" : "x86_64";
  const target = `${architecture}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
  const suffix = platform === "win32" ? ".exe" : "";
  const version = "0.167.0";
  const source = join(root, "source"); const cache = join(root, "cache");
  const destination = join(cache, "codex-terminal-server", version, target);
  const metadata = { layoutVersion: 1, version, target, variant: "codex-app-server", entrypoint: `bin/codex-app-server${suffix}`,
    execServer: `bin/codex-exec-server${suffix}`, resourcesDir: "codex-resources", pathDir: "codex-path" };
  await Promise.all(["bin", "codex-path", "codex-resources"].map(dir => mkdir(join(source, dir), { recursive: true })));
  for (const file of [metadata.entrypoint, metadata.execServer, `bin/codex-code-mode-host${suffix}`, `codex-path/rg${suffix}`,
    ...(platform === "linux" ? ["codex-resources/bwrap"] : platform === "win32" ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : [])]) {
    await writeFile(join(source, file), "synthetic executable\n", { mode: 0o755 });
  }
  let archive: Buffer;
  const assetName = `codex-app-server-package-${target}.tar.gz`;
  const asset = { name: assetName, size: 0, digest: "", browser_download_url: `https://github.com/openai/codex/releases/download/rust-v${version}/${assetName}` };
  const repack = async () => {
    await writeFile(join(source, "codex-package.json"), JSON.stringify(metadata));
    await execute("tar", ["-czf", join(root, "package.tar.gz"), "-C", source, "."]);
    archive = await readFile(join(root, "package.tar.gz"));
    asset.size = archive.length; asset.digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  };
  await repack();
  const release = { tag_name: `rust-v${version}`, assets: [asset] };
  // `init` carries the caller's cancellation; the test-only typecheck needs it in the mock's signature.
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => url.startsWith("https://api.github.com/")
    ? Response.json(release) : new Response(new Uint8Array(archive)));
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command === "tar") return execute(command, args);
    if (command === cli.command) { expect(args).toEqual([...cli.prefixArgs, "--version"]); return { stdout: `codex-cli ${version}\n`, stderr: "" }; }
    return { stdout: args.includes("--version") ? `codex-app-server ${version}\n` : "Usage: codex-app-server --session-source <SOURCE> --listen <URL>", stderr: "" };
  });
  const options: CodexTerminalServerOptions = { root: cache, platform, arch, fetch, run };
  return { root, source, cache, destination, metadata, release, asset, repack, fetch, run, options };
}

describe("source-aware Codex terminal server", () => {
  // The selected CLI must never silently fall back to the VSCode-sourced subcommand.
  it("installs the exact official complete package atomically and reuses it offline", async () => {
    const h = await fixture();
    const result = await resolveCodexTerminalServer(cli, h.options);
    expect(result).toEqual({ command: join(h.destination, "bin/codex-app-server"), prefixArgs: [] });
    expect(h.fetch).toHaveBeenNthCalledWith(1, "https://api.github.com/repos/openai/codex/releases/tags/rust-v0.167.0", expect.anything());
    expect(h.fetch).toHaveBeenNthCalledWith(2, h.asset.browser_download_url, expect.anything());
    expect(await readFile(join(h.destination, "bin/codex-code-mode-host"), "utf8")).toContain("synthetic");
    h.fetch.mockRejectedValue(new Error("offline"));
    expect(await resolveCodexTerminalServer(cli, h.options)).toEqual(result);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual(["aarch64-apple-darwin"]);
  });

  // All callers share preparation, preventing a second half-written cache or duplicate download.
  it("converges concurrent preparation on one validated install", async () => {
    const h = await fixture();
    const results = await Promise.all(Array.from({ length: 3 }, () => resolveCodexTerminalServer(cli, h.options)));
    expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  // Separate Host processes can publish while this process downloads. Keep and validate the winner.
  it("uses a complete package published by another preparer", async () => {
    const h = await fixture();
    const run = h.run.getMockImplementation()!;
    let published = false;
    h.run.mockImplementation(async (command, args) => {
      const result = await run(command, args);
      if (!published && command.includes(".tmp-") && args.includes("--help")) {
        published = true; await cp(h.source, h.destination, { recursive: true });
        await writeFile(join(h.destination, "winner.txt"), "another preparer");
      }
      return result;
    });
    const result = await resolveCodexTerminalServer(cli, h.options);
    expect(result.command).toBe(join(h.destination, h.metadata.entrypoint));
    expect(await readFile(join(h.destination, "winner.txt"), "utf8")).toBe("another preparer");
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual(["aarch64-apple-darwin"]);
  });

  // Platform names are GitHub target triples, not npm aliases or host defaults.
  it.each([
    ["darwin", "x64"], ["darwin", "arm64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["win32", "arm64"],
  ] as const)("selects the complete %s/%s release asset", async (platform, arch) => {
    const h = await fixture(platform, arch);
    expect((await resolveCodexTerminalServer(cli, h.options)).command).toBe(join(h.destination, h.metadata.entrypoint));
  });

  // Unverified or differently versioned downloads cannot be executed or published.
  it.each(["tag", "digest", "size", "origin", "missing"] as const)("rejects invalid release %s before extraction", async field => {
    const h = await fixture();
    if (field === "tag") h.release.tag_name = "rust-v0.168.0";
    if (field === "digest") h.asset.digest = "";
    if (field === "size") h.asset.size = 0;
    if (field === "origin") h.asset.browser_download_url = "https://elsewhere.test/package.tar.gz";
    if (field === "missing") h.release.assets = [];
    await expect(resolveCodexTerminalServer(cli, h.options)).rejects.toThrow(/官方.*发布包/);
    expect(h.run.mock.calls.some(([command]) => command === "tar")).toBe(false);
    await expect(readFile(join(h.destination, "codex-package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["digest", "size"] as const)("rejects downloaded bytes with a mismatched %s", async field => {
    const h = await fixture();
    if (field === "digest") h.asset.digest = `sha256:${"0".repeat(64)}`;
    else h.asset.size += 1;
    await expect(resolveCodexTerminalServer(cli, h.options)).rejects.toThrow(/完整性校验失败/);
    expect(h.run.mock.calls.some(([command]) => command === "tar")).toBe(false);
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual([]);
  });

  // The manifest and binaries are both checked; a correct label cannot mask an incompatible executable.
  it.each(["metadata", "helper", "version", "flag"] as const)("does not publish an invalid package %s", async field => {
    const h = await fixture();
    if (field === "metadata") h.metadata.variant = "codex";
    if (field === "helper") await rm(join(h.source, "bin/codex-code-mode-host"));
    await h.repack();
    const run = h.run.getMockImplementation()!;
    h.run.mockImplementation(async (command, args) => {
      if (command !== cli.command && command !== "tar") {
        if (field === "version" && args.includes("--version")) return { stdout: "codex-app-server 0.168.0", stderr: "" };
        if (field === "flag" && args.includes("--help")) return { stdout: "Usage: app-server --listen URL", stderr: "" };
      }
      return run(command, args);
    });
    await expect(resolveCodexTerminalServer(cli, h.options)).rejects.toThrow(/终端服务包/);
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual([]);
  });

  // A failed preparation cleans only its staging directory; existing state is not an owned temporary file.
  it("preserves an invalid existing cache and unrelated temporary files", async () => {
    const h = await fixture();
    await mkdir(h.destination, { recursive: true });
    await writeFile(join(h.destination, "keep.txt"), "existing");
    await expect(resolveCodexTerminalServer(cli, h.options)).rejects.toThrow(/终端服务包/);
    expect(await readFile(join(h.destination, "keep.txt"), "utf8")).toBe("existing");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("cleans its failed download without removing another preparer's staging directory", async () => {
    const h = await fixture();
    const other = `${h.destination}.tmp-other`;
    await mkdir(other, { recursive: true }); await writeFile(join(other, "keep.txt"), "owned elsewhere");
    h.fetch.mockImplementation(async url => {
      if (url.startsWith("https://api.github.com/")) return Response.json(h.release);
      throw new Error("download interrupted");
    });
    await expect(resolveCodexTerminalServer(cli, h.options)).rejects.toThrow("download interrupted");
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual(["aarch64-apple-darwin.tmp-other"]);
    expect(await readFile(join(other, "keep.txt"), "utf8")).toBe("owned elsewhere");
  });

  // The Host prepares this package off the connection path, so the UI needs real byte counts
  // to show what is taking time, and pausing must cancel the transfer instead of orphaning it.
  it("reports download progress and cancels an aborted download without publishing", async () => {
    const h = await fixture();
    const progress: { received: number; total: number }[] = [];
    await resolveCodexTerminalServer(cli, { ...h.options, onProgress: (received, total) => progress.push({ received, total }) });
    expect(progress.at(-1)).toEqual({ received: h.asset.size, total: h.asset.size });
    expect(progress.every(entry => entry.total === h.asset.size)).toBe(true);
    expect(progress.every((entry, index) => index === 0 || entry.received >= progress[index - 1]!.received)).toBe(true);

    const aborted = await fixture();
    const controller = new AbortController();
    aborted.fetch.mockImplementation(async (url, init) => {
      if (url.startsWith("https://api.github.com/")) return Response.json(aborted.release);
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const pending = resolveCodexTerminalServer(cli, { ...aborted.options, signal: controller.signal });
    await vi.waitFor(() => expect(aborted.fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await readdir(join(aborted.cache, "codex-terminal-server", "0.167.0"))).toEqual([]);
    await expect(readFile(join(aborted.destination, "codex-package.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  // ADR-0081 review: a pause cancels the paused Host's preparation while the resumed Host may already
  // share it. The resumed caller was not cancelled and must get the package, not the other abort.
  it("restarts a shared preparation that another caller cancelled", async () => {
    const h = await fixture();
    const paused = new AbortController();
    const resumed = new AbortController();
    let downloads = 0;
    h.fetch.mockImplementation(async (url, init) => {
      if (url.startsWith("https://api.github.com/")) return Response.json(h.release);
      downloads += 1;
      if (downloads === 1) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      const archive = await readFile(join(h.root, "package.tar.gz"));
      return new Response(new Uint8Array(archive));
    });
    const first = resolveCodexTerminalServer(cli, { ...h.options, signal: paused.signal });
    await vi.waitFor(() => expect(downloads).toBe(1));
    const second = resolveCodexTerminalServer(cli, { ...h.options, signal: resumed.signal });
    paused.abort();
    await expect(first).rejects.toThrow();
    await expect(second).resolves.toEqual({ command: join(h.destination, "bin/codex-app-server"), prefixArgs: [] });
    expect(downloads).toBe(2);
    expect(await readdir(join(h.cache, "codex-terminal-server", "0.167.0"))).toEqual(["aarch64-apple-darwin"]);
  });

  it("lets a caller stop waiting for a preparation it only joined", async () => {
    const h = await fixture();
    const owner = new AbortController();
    const joined = new AbortController();
    h.fetch.mockImplementation(async (url, init) => {
      if (url.startsWith("https://api.github.com/")) return Response.json(h.release);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const first = resolveCodexTerminalServer(cli, { ...h.options, signal: owner.signal });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    const second = resolveCodexTerminalServer(cli, { ...h.options, signal: joined.signal });
    joined.abort();
    await expect(second).rejects.toThrow();
    owner.abort();
    await expect(first).rejects.toThrow();
  });
});
