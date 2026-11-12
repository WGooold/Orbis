// S58 / SC82: user-installed CLI launchers retain PATH order, runtime selection and
// upgrade indirection; DSH imports must follow that same installation.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCommandForEntry, agentInvocation, agentPowerShellScript, resolveAgentPackage, stopAgentProcess } from "./agent-command.js";
import { findAgentCopies, queryAgentStatus } from "./agent-installation.js";
import { dshPackageEntry, resolveDshCommand } from "./dsh-client.js";
import { loadDshWebProtocol } from "./dsh-web-client.js";
import { findClaudeExecutable } from "./claude-integration-install.js";

const roots: string[] = [];
const execute = promisify(execFile);
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "orbis-cli-path-")); roots.push(root); return root; }
async function file(path: string, content = "", executable = false) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
  if (executable) await chmod(path, 0o755);
  return path;
}
async function pkg(root: string, name: string, command: string, version = "1.0.0", bin = "lib/bin.js") {
  await file(join(root, "package.json"), JSON.stringify({ name, version, bin: { [command]: bin } }));
  return file(join(root, bin), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`, true);
}

describe("user CLI discovery", () => {
  it("keeps quoted Windows PATH order and PATHEXT precedence across native and npm launchers", async () => {
    const root = await fixture(); const first = join(root, "用户 One"); const second = join(root, "Two");
    const native = await file(join(first, "pi.exe"));
    await file(join(first, "pi.cmd"), "@echo off");
    const npm = await pkg(join(second, "node_modules", "@earendil-works/pi-coding-agent"), "@earendil-works/pi-coding-agent", "pi");
    const shim = await file(join(second, "pi.cmd"), '@echo off\r\nnode "%~dp0node_modules/@earendil-works/pi-coding-agent/lib/bin.js" %*');
    const env = { Path: ` "${first}" ; ${second} ; ${first} `, USERPROFILE: root };
    expect(await findAgentCopies("pi", env, "win32")).toEqual([{ entry: native }, { entry: shim, version: "1.0.0" }]);
    expect((await findAgentCopies("pi", { ...env, PATHEXT: ".CMD;.EXE" }, "win32"))[0]?.entry).toBe(join(first, "pi.cmd"));
    expect((await resolveAgentPackage("pi", shim, env, "win32"))?.entry).toBe(await realpath(npm));
  });

  it("finds the official Pi stable launcher despite a stale PATH and excludes Orbis forwarding scripts", async () => {
    const root = await fixture(); const own = join(root, "orbis-bin");
    await file(join(own, "pi.cmd"), "@echo off\r\nrem orbis-pi-command\r\n");
    const agentDir = join(root, "custom pi");
    const entry = await file(join(agentDir, "bin", "pi.cmd"), '@echo off\r\nnode "%~dp0pi-launcher.js" %*');
    expect(await findAgentCopies("pi", { PATH: own, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir }, "win32")).toEqual([{ entry }]);
    expect(await agentCommandForEntry(entry, {}, "win32")).toEqual({ command: entry, prefixArgs: [] });
  });

  it.runIf(process.platform !== "win32")("retains a POSIX official launcher across upgrades and lets it choose the runtime", async () => {
    const root = await fixture(); const bin = join(root, ".pi", "agent", "bin");
    const current = await file(join(root, ".pi", "agent", "install", "current-version"), "1.0.0");
    const entry = await file(join(bin, "pi"), `#!/bin/sh\nexec '${process.execPath}' '${join(bin, "pi-launcher.cjs")}' "$@"\n`, true);
    await file(join(bin, "pi-launcher.cjs"), `console.log(require('fs').readFileSync(${JSON.stringify(current)},'utf8'));`);
    const env = { HOME: root, PATH: "/usr/bin:/bin" };
    expect((await findAgentCopies("pi", env, "darwin"))[0]?.entry).toBe(entry);
    const cli = await agentCommandForEntry(entry, env, "darwin");
    expect((await execute(cli.command, ["--version"], { env })).stdout.trim()).toBe("1.0.0");
    await writeFile(current, "2.0.0");
    expect((await execute(cli.command, ["--version"], { env })).stdout.trim()).toBe("2.0.0");
    expect((await queryAgentStatus("pi", join(root, "managed"), { installed: true, installedButBroken: false, entry })).installationSource).toBe("custom");
  });

  it.runIf(process.platform !== "win32")("resolves npm, Homebrew and Bun symlinks without replacing the stable command", async () => {
    const root = await fixture(); const bin = join(root, "bin"); await mkdir(bin);
    const target = await pkg(join(root, ".bun", "install", "global", "node_modules", "@deepseek-ai/dsh"), "@deepseek-ai/dsh", "dsh");
    const entry = join(bin, "dsh"); await symlink(target, entry);
    const second = join(root, "another-bin"); await mkdir(second); await symlink(target, join(second, "dsh"));
    const env = { HOME: root, PATH: [bin, second].join(":") };
    expect(await findAgentCopies("dsh", env, "darwin")).toEqual([{ entry, version: "1.0.0" }]);
    const cli = await resolveDshCommand(env, "darwin");
    expect(cli).toEqual({ command: entry, prefixArgs: [], packageEntry: await realpath(target) });
    expect(dshPackageEntry(cli)).toBe(await realpath(target));
    expect((await queryAgentStatus("dsh", join(root, "managed"), { installed: true, installedButBroken: false, entry })).installationSource).toBe("custom");
  });

  it("reads pnpm's wrapper target and imports only the matching DSH protocol packages", async () => {
    const root = await fixture(); const bin = join(root, "pnpm");
    const packageRoot = join(bin, "global", "5", "node_modules", ".pnpm", "dsh@1", "node_modules", "@deepseek-ai", "dsh");
    const target = await pkg(packageRoot, "@deepseek-ai/dsh", "dsh");
    const entry = await file(join(bin, "dsh.cmd"), '@echo off\r\n"%dp0%node.exe" "%dp0%global/5/node_modules/.pnpm/dsh@1/node_modules/@deepseek-ai/dsh/lib/bin.js" %*');
    const cli = await resolveDshCommand({ PATH: bin, USERPROFILE: root }, "win32");
    expect(cli).toEqual({ command: entry, prefixArgs: [], packageEntry: await realpath(target) });
    const modules = dirname(packageRoot);
    await file(join(modules, "dsh-api-gateway", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-api-gateway", type: "module", exports: { "./stream-protocol": "./protocol.js" } }));
    await file(join(modules, "dsh-api-gateway", "protocol.js"), 'export const REMOTE_STREAM_MUX_PATH="/selected"; export const REMOTE_EVENT_STREAM_ENDPOINT="/events"; export const REMOTE_EVENT_RESULT_ENDPOINT="/result"; export const parseRemoteStreamServerMessage=JSON.parse; export const parseRemoteEventResult=x=>x;');
    await file(join(modules, "dsh-client-connection", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-client-connection", type: "module", exports: "./index.js" }));
    await file(join(modules, "dsh-client-connection", "index.js"), 'export const serverResponseSchema={parse:x=>x};');
    expect((await loadDshWebProtocol(cli.packageEntry!)).muxPath).toBe("/selected");
    // A custom wrapper without a statically identifiable target must not borrow another PATH copy.
    const opaque = await file(join(root, "custom", "dsh.cmd"), "@echo off\r\nother-manager run dsh %*");
    expect(await resolveAgentPackage("dsh", opaque, { PATH: bin }, "win32")).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("uses Volta's selected bin while retaining its native shim", async () => {
    const root = await fixture(); const volta = join(root, ".volta");
    const target = await pkg(join(volta, "tools", "image", "packages", "@deepseek-ai/dsh"), "@deepseek-ai/dsh", "dsh");
    const entry = await file(join(volta, "bin", "dsh"), "#!/bin/sh\nexit 0\n", true);
    await file(join(volta, "bin", "volta"), `#!/bin/sh\nprintf '%s\\n' '${target}'\n`, true);
    expect(await resolveDshCommand({ HOME: root, VOLTA_HOME: volta, PATH: "" }, "darwin"))
      .toEqual({ command: entry, prefixArgs: [], packageEntry: await realpath(target) });
  });

  it.runIf(process.platform !== "win32")("keeps a broken first symlink visible instead of switching to a different version", async () => {
    const root = await fixture(); const first = join(root, "first"); const second = join(root, "second");
    await mkdir(first); const broken = join(first, "pi"); await symlink(join(root, "missing"), broken);
    const other = await file(join(second, "pi"), "#!/bin/sh\nexit 0\n", true);
    expect(await findAgentCopies("pi", { HOME: root, PATH: `${first}:${second}` }, "darwin"))
      .toEqual([{ entry: broken }, { entry: other }]);
    await expect(agentCommandForEntry(broken)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finds Claude exe/cmd/bat/ps1 with quoted paths and native fallback locations", async () => {
    const root = await fixture(); const bin = join(root, "用户 tools");
    for (const extension of ["exe", "cmd", "bat", "ps1"]) {
      const entry = await file(join(bin, `claude.${extension}`));
      expect(await findClaudeExecutable({ Path: ` "${bin}" ` }, "win32", root)).toBe(entry);
      await rm(entry);
    }
    const native = await file(join(root, ".local", "bin", "claude.exe"));
    expect(await findClaudeExecutable({ PATH: "", USERPROFILE: root }, "win32")).toBe(native);
  });

  it("uses an adjacent Node for a bare external JS entry and bundled Node for managed installations", async () => {
    const root = await fixture(); const prefix = join(root, "external");
    const entry = await pkg(join(prefix, "node_modules", "@deepseek-ai/dsh"), "@deepseek-ai/dsh", "dsh");
    const node = await file(join(prefix, "node.exe"));
    expect(await agentCommandForEntry(entry, {}, "win32")).toEqual({ command: node, prefixArgs: [entry] });
    expect(await agentCommandForEntry(entry, { ORBIS_AGENT_INSTALL_ROOT: root }, "win32"))
      .toEqual({ command: process.execPath, prefixArgs: [entry] });
  });
});

describe("Windows script invocation", () => {
  // Official launchers can keep their own child alive; stopping a probe must not orphan it.
  it.runIf(process.platform !== "win32")("terminates an isolated launcher and its owned descendant", async () => {
    const script = `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const descendant = await new Promise<number>((resolve, reject) => {
        child.once("error", reject); child.stdout.once("data", bytes => resolve(Number(bytes.toString().trim())));
      });
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      await stopAgentProcess(child);
      await vi.waitFor(() => { expect(() => process.kill(descendant, 0)).toThrow(); }, { timeout: 3000 });
    } finally { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already reaped. */ } } }
  });

  it("escapes batch arguments, disables delayed expansion and shares the invocation with terminals", () => {
    const cli = { command: "C:\\用户 Tools\\pi.cmd", prefixArgs: [] };
    const args = ["--model", 'name & tool|%PATH%! "quoted"', "C:\\space path\\"];
    const invocation = agentInvocation(cli, args, { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32");
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(invocation.args[4]).toContain("^&");
    expect(invocation.args[4]).toContain("^%PATH^%");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(agentPowerShellScript(cli, args)).toContain(invocation.args.join(" "));
    expect(() => agentInvocation(cli, ["bad\narg"], {}, "win32")).toThrow("无效换行");
  });

  it("uses PowerShell only for ps1 and leaves native argv unchanged", () => {
    const cli = { command: "C:\\用户's Tools\\claude.ps1", prefixArgs: [] };
    const invocation = agentInvocation(cli, ["--model", "a'; & bad"], {}, "win32");
    expect(Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le")).toContain("'a''; & bad'");
    expect(agentInvocation({ command: "C:\\claude.exe", prefixArgs: [] }, ["a & b"], {}, "win32"))
      .toEqual({ command: "C:\\claude.exe", args: ["a & b"] });
  });

  // Execute the parser boundaries on Windows CI; POSIX cannot validate cmd.exe behavior.
  it.runIf(process.platform === "win32")("round trips batch argv and RPC stdin through a real Windows interpreter", async () => {
    const root = await fixture();
    const js = await file(join(root, "echo.cjs"), "let data=''; process.stdin.on('data',x=>data+=x); process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),data}))); ");
    const entry = await file(join(root, "用户 tool.cmd"), `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    const args = ["space value", 'quote"value', "a&b|c", "%PATH%", "bang!", "C:\\end\\", ""];
    const invocation = agentInvocation({ command: entry, prefixArgs: [] }, args);
    const pending = new Promise<{ stdout: string }>((resolve, reject) => {
      const child = execFile(invocation.command, invocation.args, { windowsVerbatimArguments: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
      child.stdin!.end('{"type":"get_state"}\n');
    });
    expect(JSON.parse((await pending).stdout)).toEqual({ args, data: '{"type":"get_state"}\n' });
    expect(await readFile(entry, "utf8")).toContain("%*");
  });
});
