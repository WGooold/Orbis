import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "@orbis/protocol";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { OpenCodeBackend } from "./opencode-backend.js";
import { OPENCODE_CLIENT_VERSION, OpenCodeServiceConnection, openCodeTerminalService } from "./opencode-service-connection.js";

const binary = process.env.ORBIS_OPENCODE_TEST_BINARY;
const loopback = "127.0.0.1";
const timing = { timeout: 10_000, interval: 50 };
const fixtureModel = "orbis-test-model";
const appInput = "Native PTY regression prompt";
const appReply = "Native PTY regression response";
const appTitle = "Orbis Tab Fixture";
const controlTitle = "Desktop Tab Fixture";
const ignoredTitle = "Ignored Desktop Fixture";

interface Tab {
  sessionID: string;
  title?: string;
  active: boolean;
  busy: boolean;
  attention: boolean;
  unread?: "activity" | "error";
}
interface Snapshot {
  pid: number;
  generation: number;
  current: { type: string; sessionID?: string };
  tabs: Tab[];
  seen: string[];
}

// The observer never opens, focuses, closes, or renders a tab. Its own output goes
// to a file, so a title matching the PTY transcript must come from OpenCode itself.
const observer = `import { appendFileSync } from "node:fs";
export default {
  id: "orbis-pty-observer",
  setup(context) {
    const seen = new Set();
    const generation = 1 + (globalThis.orbisPtyObserverGeneration ?? 0);
    globalThis.orbisPtyObserverGeneration = generation;
    const stop = context.data.on("session.created", event => seen.add(event.data.sessionID));
    let previous;
    const timer = setInterval(() => {
      const state = JSON.stringify({ pid: process.pid, generation, current: context.ui.router.current(),
        tabs: context.ui.tabs.list(), seen: [...seen] });
      if (state === previous) return;
      previous = state;
      appendFileSync(process.env.ORBIS_PTY_OBSERVATIONS, state + "\\n");
    }, 30);
    return () => { stop(); clearInterval(timer); };
  },
};
`;

async function bareExecutable(path: string): Promise<string> {
  const resolved = await realpath(resolve(path));
  const file = await open(resolved);
  try {
    const magic = Buffer.alloc(4);
    await file.read(magic);
    const nativeHeaders = ["7f454c46", "cffaedfe", "feedfacf", "cafebabe", "cafebabf", "bebafeca", "bfbafeca"];
    if (!nativeHeaders.includes(magic.toString("hex"))) throw new Error("ORBIS_OPENCODE_TEST_BINARY must be the bare OpenCode binary, not its launcher script");
  } finally { await file.close(); }
  return resolved;
}

function ownChild(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, { cwd, env, stdio: "pipe" });
  const events: { error?: Error; exit?: { code: number | null; signal: NodeJS.Signals | null } } = {};
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout = (stdout + text).slice(-262_144); });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-16_384); });
  child.stdin.on("error", () => {}); // The fixture may already have exited when cleanup closes its pipe.
  child.on("error", error => { events.error = error; });
  child.on("exit", (code, signal) => { events.exit = { code, signal }; });
  const closed = new Promise<void>(done => child.once("close", () => done()));
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    alive() {
      if (events.error) throw events.error;
      if (events.exit) throw new Error(`Fixture child exited: ${JSON.stringify(events.exit)}`);
    },
    async stop(graceful?: () => void) {
      if (!events.exit && !events.error) {
        if (graceful) graceful();
        else child.kill();
        // The PTY helper has its own one-second reap/kill deadline for the CLI.
        const deadline = AbortSignal.timeout(3_000);
        while (!events.exit && !events.error && !deadline.aborted) await delay(25);
        if (!events.exit && !events.error) child.kill("SIGKILL");
      }
      await closed;
    },
  };
}

async function drivePort() {
  // The Drive manifest requires a concrete port (not zero). Before connecting,
  // also verify that the owned service actually started that Drive endpoint.
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, done);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

interface DriveMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: { id: string; url: string; body: unknown };
}

function connectDrive(endpoint: string) {
  const socket = new WebSocket(endpoint, { handshakeTimeout: timing.timeout });
  const received: DriveMessage[] = [];
  let id = 0;
  let fault: Error | undefined;
  socket.on("message", message => { received.push(JSON.parse(message.toString()) as DriveMessage); });
  socket.on("error", error => { fault = error; });
  const check = () => {
    if (fault) throw fault;
    expect(socket.readyState).toBe(WebSocket.OPEN);
  };
  return {
    stop: () => socket.terminate(),
    async request(method: string, params?: unknown) {
      await vi.waitFor(check, timing);
      const requestId = ++id;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      const response = await vi.waitFor(() => {
        check();
        const response = received.find(item => item.id === requestId);
        if (!response) throw new Error(`Missing Drive reply to ${method}`);
        return response;
      }, timing);
      if (response.error) throw new Error(`Drive replied to ${method} with ${JSON.stringify(response.error)}`);
      return response.result;
    },
    async invocationFor(text: string) {
      return vi.waitFor(() => {
        check();
        const invocation = received.find(item => item.method === "llm.request" && JSON.stringify(item.params?.body)?.includes(text))?.params;
        if (!invocation) throw new Error(`No simulated model invocation for ${text}`);
        return invocation;
      }, timing);
    },
  };
}

function visibleTerminal(output: string) {
  // OpenTUI repaints changed cells, not whole labels. Track its cursor and cells
  // instead of searching adjacent bytes of the transcript (or OSC status titles).
  const width = 120, height = 42;
  const lines = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  let row = 0, column = 0;
  // eslint-disable-next-line no-control-regex -- The input is a VT transcript.
  for (const match of output.matchAll(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[([0-?]*)[ -/]*([@-~])|[ -/]*[0-~])|./gsu)) {
    const [text, params, command] = match;
    const [a, b] = params?.split(";").map(Number) ?? [];
    const n = a || 1;
    if (command === "H" || command === "f") { row = n - 1; column = (b || 1) - 1; }
    else if (command === "A") row -= n;
    else if (command === "B") row += n;
    else if (command === "C") column += n;
    else if (command === "D") column -= n;
    else if (command === "G") column = n - 1;
    else if (command === "d") row = n - 1;
    else if (command === "J" && (a === 2 || a === 3)) lines.forEach(line => line.fill(" "));
    else if (command === "K") lines[row]?.fill(" ", a === 1 || a === 2 ? 0 : column, a === 1 ? column + 1 : width);
    else if (command === "X") lines[row]?.fill(" ", column, column + n);
    else if (text === "\r") column = 0;
    else if (text === "\n") row++;
    else if (text === "\b") column--;
    else if (text >= " " && column < width && lines[row] && !/\p{Mark}/u.test(text)) {
      lines[row]![column++] = text;
      if (/[\p{Extended_Pictographic}\p{Script=Han}]/u.test(text) && column < width) lines[row]![column++] = "";
    }
    row = Math.max(0, Math.min(row, height - 1));
    column = Math.max(0, Math.min(column, width));
  }
  return lines.map(line => line.join("").trimEnd()).join("\n");
}

// Run after a Host build, with ORBIS_OPENCODE_TEST_BINARY set to the released
// OpenCode 2.3.2 native executable. The helper needs only Unix Python 3 stdlib.
it.skipIf(!binary || !["darwin", "linux"].includes(process.platform))("hot-adds App sessions to a running native OpenCode tab rail without stealing focus", async ({ skip }) => {
  const temporary = resolve(tmpdir());
  const root = await mkdtemp(join(temporary, "orbis-opencode-tabs-"));
  if (dirname(resolve(root)) !== temporary) throw new Error("OpenCode fixture directory must stay in the temporary root");
  let service: ReturnType<typeof ownChild> | undefined;
  let tui: ReturnType<typeof ownChild> | undefined;
  let drive: ReturnType<typeof connectDrive> | undefined;
  const registrationPath = join(root, "state", "opencode", "service.json");
  const observations = join(root, "tabs.jsonl");
  const connection = new OpenCodeServiceConnection({ registrationPath, pollIntervalMs: 250 });
  const events: Array<{ id: string; event: RuntimeEvent }> = [];
  const backend = new OpenCodeBackend({ connection, hostId: "orbis-native-tabs-test", reconnectMs: 100,
    onRuntimeOnline() {}, onRuntimeOffline() {}, onCatalogChange() {}, onAvailabilityChange() {},
    onEvent(id, event) { events.push({ id, event }); } });
  async function snapshots() {
    const text = await readFile(observations, "utf8");
    // Only use complete lines; Node may read between a line's append and flush.
    return text.slice(0, text.lastIndexOf("\n")).split("\n").filter(Boolean).map(row => JSON.parse(row) as Snapshot);
  }
  try {
    const work = join(await realpath(root), "isolated-project");
    const home = join(root, "home"), temp = join(root, "tmp");
    const env = { HOME: home, OPENCODE_TEST_HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp,
      XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"), PATH: join(root, "bin"),
      TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8",
      OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1" };
    await Promise.all([home, temp, work, env.XDG_STATE_HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME,
      env.XDG_RUNTIME_DIR, env.PATH].map(directory => mkdir(directory)));
    const python = spawnSync("python3", ["-I", "-c", "import pty, sys; print(sys.executable)"], {
      cwd: work, env: { ...env, PATH: process.env.PATH }, encoding: "utf8", timeout: 3_000,
    });
    if (python.status !== 0 || !python.stdout?.trim().startsWith("/")) skip("Unix Python 3 with stdlib pty is unavailable");
    const executable = await bareExecutable(binary!);
    const installer = fileURLToPath(new URL("../dist/opencode-tui-tabs-install.js", import.meta.url));
    await readFile(installer).catch(error => { throw new Error("Build the Host before running the native PTY regression", { cause: error }); });
    const { configureOpenCodeTuiTabs }: typeof import("./opencode-tui-tabs-install.js") = await import(/* @vite-ignore */ installer);
    const config = join(env.XDG_CONFIG_HOME, "opencode");
    const probe = join(config, "plugins", "orbis-pty-observer");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(probe, "tui.js"), observer);
    await writeFile(join(config, "cli.json"), JSON.stringify({ animations: false, highlights: false,
      tabs: { mode: "on", layout: "horizontal", indicators: "status" },
      keybinds: { "session.tab.next": "f5", "session.tab.close": "f6" } }));
    // OpenCode simulation denies all unmatched outbound requests. Its built-in
    // fake provider uses its normal HTTP/SSE engine with scripted model events.
    await writeFile(join(config, "opencode.json"), JSON.stringify({ model: `orbis-fixture/${fixtureModel}`,
      providers: { "orbis-fixture": { name: "Isolated fixture", package: "@opencode/ai/providers/openai/chat",
        settings: { apiKey: "fixture-only" }, models: { [fixtureModel]: { name: fixtureModel } } } } }));
    const driveRegistry = join(env.XDG_STATE_HOME, "opencode-drive", "instances");
    await mkdir(driveRegistry, { recursive: true });
    const endpoint = `ws://${loopback}:${await drivePort()}`;
    await writeFile(join(driveRegistry, "orbis-fixture.json"), JSON.stringify({ endpoints: { backend: endpoint, ui: endpoint } }));
    service = ownChild(executable, ["serve", "--service", "--hostname", loopback, "--port", "0"], work,
      { ...env, OPENCODE_SIMULATE: "1", OPENCODE_DRIVE: "orbis-fixture", OPENCODE_FILEWATCHER_DISABLE: "1" });
    backend.start();
    await connection.start();
    await vi.waitFor(() => {
      service!.alive();
      expect(backend.isReady()).toBe(true);
      expect(service!.stderr()).toContain(`opencode drive backend websocket: ${endpoint}`);
    }, timing);
    const identity = connection.identity!;
    const client = connection.client!;
    const request = { signal: AbortSignal.timeout(40_000) };
    expect(identity.pid).toBe(service.child.pid);
    expect(new URL(identity.origin).hostname).toBe(loopback);
    expect((await client.server.info(request)).version).toBe(OPENCODE_CLIENT_VERSION);
    const { password } = await openCodeTerminalService(identity, registrationPath);
    expect(password).toBeTruthy();
    drive = connectDrive(endpoint);
    expect(await drive.request("llm.attach")).toEqual({ attached: true });

    const control = await client.session.create({ location: { directory: work }, title: controlTitle }, request);
    const helper = fileURLToPath(new URL("./fixtures/opencode-native-pty.py", import.meta.url));
    tui = ownChild(python.stdout.trim(), ["-I", helper, executable, "--server", identity.origin, "--session", control.id], work,
      { ...env, OPENCODE_PASSWORD: password!, ORBIS_PTY_OBSERVATIONS: observations });
    const waitForTabs = (check: (state: Snapshot) => void) => vi.waitFor(async () => {
      tui!.alive();
      const state = (await snapshots()).at(-1);
      if (!state) throw new Error("No native tab snapshots have arrived");
      check(state);
      return state;
    }, timing);
    const expectControlCurrent = (state: Snapshot) => {
      expect(state.current).toMatchObject({ type: "session", sessionID: control.id });
      expect(state.tabs).toContainEqual(expect.objectContaining({ sessionID: control.id, active: true }));
    };
    const baseline = await waitForTabs(state => {
      expectControlCurrent(state);
      expect(state.tabs).toHaveLength(1);
      expect(visibleTerminal(tui!.stdout())).toContain(controlTitle);
    });
    expect(tui.stderr()).toContain(`PTY child: ${baseline.pid}\n`);

    // Enable only now: the test already has a rendered desktop session in this same TUI.
    await configureOpenCodeTuiTabs(true, () => {}, env);
    // OpenCode reactivates its plugin inventory on a membership change. Wait
    // for the observer's new generation rather than racing the watcher debounce.
    await waitForTabs(state => {
      expectControlCurrent(state);
      expect(state.pid).toBe(baseline.pid);
      expect(state.generation).toBeGreaterThan(baseline.generation);
    });
    const ignored = await client.session.create({ location: { directory: work }, title: ignoredTitle }, request);
    const activation = await backend.activate({ type: "new", cwd: work }, { deviceId: "synthetic-device-id" });
    expect(activation.spawnMode).toBe("headless");
    const sessionID = activation.sessionId!;
    await client.session.update({ sessionID, title: appTitle }, request);
    expect(await client.session.get({ sessionID }, request)).toMatchObject({
      id: sessionID, metadata: { "orbis.app.session": 1 }, location: { directory: work },
    });
    expect(ignored.metadata?.["orbis.app.session"]).toBeUndefined();
    const expectAppBackground = (state: Snapshot, status: Partial<Tab>) => {
      expectControlCurrent(state);
      expect(state.pid).toBe(baseline.pid);
      expect(state.seen).toEqual(expect.arrayContaining([ignored.id, sessionID]));
      expect(state.tabs).toHaveLength(2);
      expect(state.tabs).toContainEqual(expect.objectContaining({ sessionID, active: false, title: appTitle, ...status }));
      const screen = visibleTerminal(tui!.stdout());
      const rail = screen.split("\n").find(line => line.includes(controlTitle) && line.includes(appTitle));
      expect(rail).toBeDefined();
      expect(screen).not.toContain(ignoredTitle);
      const indicator = rail!.split(appTitle)[0]!.trimEnd();
      if (status.busy) expect(indicator).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
      if (status.unread) expect(indicator).toMatch(/•$/u);
    };
    await waitForTabs(state => expectAppBackground(state, { busy: false }));

    const runtimeId = `opencode:${sessionID}`;
    expect(backend.dispatchCommand(runtimeId, "send", { type: "user_message", messageId: "pty-app-input", text: appInput })).toBe("handled");
    await vi.waitFor(() => expect(events).toContainEqual({ id: runtimeId, event: {
      type: "command.result", commandId: "send", ok: true, status: "success",
    } }), timing);
    const invocation = await drive.invocationFor(appInput);
    expect(invocation).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", body: { model: fixtureModel } });
    await waitForTabs(state => expectAppBackground(state, { busy: true, attention: false }));
    // The provider cannot complete until the native rail has really observed busy.
    expect(await drive.request("llm.chunk", { id: invocation.id, items: [{ type: "textDelta", text: appReply }] })).toEqual({ ok: true });
    expect(await drive.request("llm.finish", { id: invocation.id, reason: "stop" })).toEqual({ ok: true });
    await waitForTabs(state => expectAppBackground(state, { busy: false, unread: "activity" }));
    expect((await client.message.list({ sessionID, type: "user" }, request)).data).toContainEqual(expect.objectContaining({
      text: appInput, metadata: expect.objectContaining({ "orbis.clientMessageId": "pty-app-input" }),
    }));
    const beforeInput = await snapshots();
    for (const snapshot of beforeInput.slice(beforeInput.indexOf(beforeInput.find(value => value.current.sessionID === control.id)!))) {
      expect(snapshot.current.sessionID).toBe(control.id);
      expect(snapshot.tabs.map(tab => tab.sessionID)).not.toContain(ignored.id);
    }

    // This is the first terminal input. Select the already-proven tab and close
    // it using real OpenCode keybindings. Future updates must not auto-reopen it.
    tui.child.stdin.write("\u001b[15~"); // F5
    await waitForTabs(state => expect(state.current.sessionID).toBe(sessionID));
    tui.child.stdin.write("\u001b[17~"); // F6
    await waitForTabs(state => { expectControlCurrent(state); expect(state.tabs).toHaveLength(1); });
    await client.session.update({ sessionID, title: "Closed Orbis Fixture" }, request);
    // A different working directory on the same service also fits in the existing rail.
    const other = join(work, "other-workspace");
    await mkdir(other);
    const afterClose = await backend.activate({ type: "new", cwd: other }, { deviceId: "synthetic-device-id" });
    const expectedTabs = [control.id, afterClose.sessionId];
    const beforeDisable = await waitForTabs(state => {
      expectControlCurrent(state);
      expect(state.tabs.map(tab => tab.sessionID)).toEqual(expectedTabs);
    });
    expect((await client.session.get({ sessionID: afterClose.sessionId! }, request)).location.directory).toBe(other);
    expect((await client.session.get({ sessionID }, request)).id).toBe(sessionID);

    await configureOpenCodeTuiTabs(false, () => {}, env);
    await waitForTabs(state => {
      expect(state.generation).toBeGreaterThan(beforeDisable.generation);
      expect(state.tabs.map(tab => tab.sessionID)).toEqual(expectedTabs);
    });
    const disabled = await backend.activate({ type: "new", cwd: work }, { deviceId: "synthetic-device-id" });
    await waitForTabs(state => {
      expect(state.seen).toContain(disabled.sessionId);
      expect(state.pid).toBe(baseline.pid);
      expectControlCurrent(state);
      expect(state.tabs.map(tab => tab.sessionID)).toEqual(expectedTabs);
    });
    expect((await client.server.info(request)).pid).toBe(service.child.pid);
    expect((await client.session.list({ directory: work }, request)).data.map(row => row.id).sort())
      .toEqual([control.id, ignored.id, sessionID, disabled.sessionId!].sort());
  } catch (error) {
    if (service || tui) {
      const diagnostics = [service?.stderr(), tui?.stderr(), tui ? visibleTerminal(tui.stdout()).slice(-2000) : undefined,
        await snapshots().then(states => JSON.stringify(states.at(-1))).catch(() => undefined)].filter(Boolean).join("\n");
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nNative fixture diagnostics:\n${diagnostics}`, { cause: error });
    }
    throw error;
  } finally {
    backend.close();
    connection.close();
    drive?.stop();
    await tui?.stop(() => tui?.child.stdin.end());
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 65_000);
