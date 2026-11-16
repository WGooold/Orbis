// CODEX-SHARED-HISTORY-01 / SC75: Assert native source and writer lifetime, not Orbis labels or
// initialize names. Opt-in uses the selected official CLI, isolated home and a
// local Responses fixture; no real credentials, user sessions or model calls.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServer } from "./codex-daemon.js";
import { CodexRuntime } from "./codex-runtime.js";
import { createCodexTerminalConnection } from "./codex-terminal-connection.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
type NativeThread = { id: string; source: string; path?: string };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-native-source-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  let calls = 0, hold = false, release: (() => void) | undefined;
  const http = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk; /* Only synthetic input. */ }
    const number = ++calls;
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = { id: `msg_${number}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Synthetic reply.", annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: `resp_${number}`, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${number}`, status: "completed", output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { release?.(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  await writeFile(join(home, "config.toml"), [
    'model = "gpt-5.5"', 'model_provider = "probe"', 'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"', 'thread_unload_delay_secs = 1800',
    '[model_providers.probe]', 'name = "Synthetic native source regression"',
    `base_url = "http://127.0.0.1:${(http.address() as AddressInfo).port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
  ].join("\n") + "\n");
  const open = async () => {
    const server = await CodexAppServer.create({ requestTimeoutMs: 15_000,
      spawnImpl: (command, args, options) => {
        // Exercise the production environment cleanup without inheriting any credentials.
        expect(options?.env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBeUndefined();
        return spawn(command, args, { ...options, cwd,
          env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home } });
      },
    });
    cleanup.push(() => server.stop());
    return server;
  };
  const completed = new Set<string>();
  const server = await open();
  const observe = () => {
    const previous = server.onNotification;
    server.onNotification = (method, params) => {
      previous?.(method, params);
      if (method === "turn/completed") completed.add((params as { threadId: string }).threadId);
    };
  };
  const turn = async (client: CodexAppServer, id: string) => {
    completed.delete(id);
    await client.request("turn/start", { threadId: id, input: [{ type: "text", text: "Synthetic source test." }] });
  };
  const complete = async (id: string) => { await vi.waitFor(() => expect(completed.has(id)).toBe(true), { timeout: 10_000 }); };
  const source = async (id: string) => {
    const dbName = (await readdir(home)).find(name => /^state_\d+\.sqlite$/u.test(name));
    expect(dbName).toBeDefined();
    const db = new DatabaseSync(join(home, dbName!), { readOnly: true });
    try { return db.prepare("SELECT source FROM threads WHERE id = ?").get(id)?.source; }
    finally { db.close(); }
  };
  return { root, home, cwd, server, open, observe, turn, complete, source,
    calls: () => calls, hold: () => { hold = true; }, release: () => { hold = false; release?.(); } };
}

describe.skipIf(process.env.ORBIS_CODEX_NATIVE_TEST !== "1")("Codex native terminal source and writer lifetime", () => {
  it("preserves the selected CLI app-server source across App, fork and remote-TUI threads and shared history", async () => {
    vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "Codex Desktop");
    const h = await fixture();
    const runtime = new CodexRuntime({ server: h.server, rolloutRoot: join(h.home, "sessions"),
      openHeadWindow: () => {}, onEvent: () => {} });
    cleanup.push(() => runtime.stop()); runtime.markStarted(); h.observe();
    const activated = await runtime.activate({ type: "new", cwd: h.cwd });
    const appThreadId = activated.sessionId!;
    expect(appThreadId).toBeDefined();
    await h.turn(h.server, appThreadId); await h.complete(appThreadId);
    const fork = (await h.server.request("thread/fork", { threadId: appThreadId })) as { thread: NativeThread };
    await h.turn(h.server, fork.thread.id); await h.complete(fork.thread.id);
    const connection = await createCodexTerminalConnection({ upstreamEndpoint: h.server.endpoint!, onThread: () => {} });
    cleanup.push(connection.close);
    const tui = await CodexAppServer.createExternal({ endpoint: connection.endpoint, clientName: "codex_cli_rs" });
    cleanup.push(() => tui.stop());
    // The Host observes a real TUI by subscribing only after its materialized first turn.
    const terminal = await tui.request("thread/start", { cwd: h.cwd }) as { thread: NativeThread };
    const tuiCompleted = new Set<string>();
    tui.onNotification = (method, params) => { if (method === "turn/completed") tuiCompleted.add((params as { threadId: string }).threadId); };
    await h.turn(tui, terminal.thread.id);
    await vi.waitFor(() => expect(tuiCompleted.has(terminal.thread.id)).toBe(true), { timeout: 10_000 });
    for (const id of [appThreadId, fork.thread.id, terminal.thread.id]) {
      const result = await h.server.request("thread/read", { threadId: id }) as { thread: NativeThread };
      await vi.waitFor(async () => expect(await h.source(id)).toBe("vscode"));
      expect(result.thread.source).toBe("vscode");
      const header = JSON.parse((await readFile(result.thread.path!, "utf8")).split("\n")[0]!) as { payload: { source: string; originator: string } };
      expect(header.payload).toMatchObject({ source: "vscode", originator: "orbis-host" });
    }
    // Another independent app-server sees the same persisted terminal history.
    // An empty source filter is what the inspected Desktop catalog sends; the
    // official TUI also includes both cli and vscode. Neither proves ownership.
    const peer = await h.open();
    for (const sourceKinds of [[], ["cli", "vscode"], ["vscode"]]) {
      const history = await peer.request("thread/list", { sourceKinds, modelProviders: [] }) as { data: NativeThread[] };
      expect(history.data.map(thread => thread.id)).toEqual(expect.arrayContaining([appThreadId, fork.thread.id, terminal.thread.id]));
    }
    expect(await peer.request("thread/loaded/list", {})).toMatchObject({ data: [] });
    expect(h.calls()).toBe(3);
  }, 60_000);

  // CODEX-SHARED-HISTORY-02: changing the native startup entry must not merge
  // the App's terminal/Desktop identities, even when both persist vscode.
  it("keeps terminal and Desktop App catalogs distinct with real installed CLI backends", async () => {
    const h = await fixture(); h.observe();
    const peer = await h.open();
    const desktopServer = await CodexAppServer.createExternal({ endpoint: peer.endpoint! });
    cleanup.push(() => desktopServer.stop());
    const terminal = new CodexRuntime({ server: h.server, rolloutRoot: join(h.home, "sessions"),
      openHeadWindow: () => {}, onEvent: () => {} });
    const desktop = new CodexRuntime({ server: desktopServer, rolloutRoot: join(h.home, "sessions"), onEvent: () => {} });
    cleanup.push(() => terminal.stop(), () => desktop.stop());
    desktop.onDesktopThread = id => terminal.seedDesktopThreads([id]);
    terminal.markStarted(); desktop.markStarted();
    // Preserve the runtime's observer while waiting for synthetic responses.
    h.observe();
    const terminalId = (await terminal.activate({ type: "new", cwd: h.cwd })).sessionId!;
    await h.turn(h.server, terminalId); await h.complete(terminalId);
    const desktopId = (await desktop.activate({ type: "new", cwd: h.cwd })).sessionId!;
    expect(desktopId).toMatch(/^codex-desktop:/u);
    const nativeDesktopId = desktopId.slice("codex-desktop:".length);
    let completed = false;
    const previous = desktopServer.onNotification;
    desktopServer.onNotification = (method, params) => {
      previous?.(method, params);
      if (method === "turn/completed") completed = true;
    };
    await h.turn(desktopServer, nativeDesktopId);
    await vi.waitFor(() => expect(completed).toBe(true));
    expect(await h.source(terminalId)).toBe("vscode");
    expect(await h.source(nativeDesktopId)).toBe("vscode");
    expect((await terminal.catalog()).map(entry => [entry.sessionId, entry.agentKind])).toEqual([[terminalId, "codex"]]);
    expect((await desktop.catalog()).map(entry => [entry.sessionId, entry.agentKind])).toEqual([[desktopId, "codexDesktop"]]);
    expect(terminal.directoryEntries().map(entry => entry.runtimeId)).toEqual([`codex:${terminalId}`]);
    expect(desktop.directoryEntries().map(entry => entry.runtimeId)).toEqual([desktopId]);
    await expect(terminal.activate({ type: "resume", sessionId: nativeDesktopId })).rejects.toThrow("不属于 Codex");
    await expect(terminal.setArchived(nativeDesktopId, true)).rejects.toThrow("属于 Codex 桌面版");
    expect(h.calls()).toBe(2);
  }, 60_000);

  it("releases an idle writer after its last subscriber leaves, while retaining another window and running turns", async () => {
    const h = await fixture(); h.observe();
    const result = await h.server.request("thread/start", { cwd: h.cwd }) as { thread: NativeThread };
    const id = result.thread.id;
    await h.turn(h.server, id); await h.complete(id);
    const peer = await h.open();
    await expect(peer.request("thread/resume", { threadId: id })).rejects.toThrow("already has an active writer");
    const tui = await CodexAppServer.createExternal({ endpoint: h.server.endpoint!, clientName: "codex_cli_rs" });
    cleanup.push(() => tui.stop());
    await tui.request("thread/resume", { threadId: id });
    await h.server.request("thread/unsubscribe", { threadId: id });
    expect(await h.server.request("thread/loaded/list", {})).toMatchObject({ data: [id] });
    await expect(peer.request("thread/resume", { threadId: id })).rejects.toThrow("already has an active writer");
    await tui.stop();
    // The fixture config keeps the writer for 30 min. Terminal scope must override it,
    // so a closed last window becomes reopenable without stopping the server.
    await vi.waitFor(async () => expect(await h.server.request("thread/loaded/list", {})).toMatchObject({ data: [] }), { timeout: 3_000 });
    await expect(peer.request("thread/resume", { threadId: id })).resolves.toMatchObject({ thread: { id } });
    await peer.request("thread/unsubscribe", { threadId: id });
    await vi.waitFor(async () => expect(await peer.request("thread/loaded/list", {})).toMatchObject({ data: [] }));
    await h.server.request("thread/resume", { threadId: id });
    h.hold(); await h.turn(h.server, id);
    await vi.waitFor(() => expect(h.calls()).toBe(2));
    await h.server.request("thread/unsubscribe", { threadId: id });
    expect(await h.server.request("thread/loaded/list", {})).toMatchObject({ data: [id] });
    await expect(peer.request("thread/resume", { threadId: id })).rejects.toThrow("already has an active writer");
    h.release();
    await vi.waitFor(async () => expect(await h.server.request("thread/loaded/list", {})).toMatchObject({ data: [] }), { timeout: 5_000 });
    await expect(peer.request("thread/resume", { threadId: id })).resolves.toMatchObject({ thread: { id } });
  }, 60_000);
});
