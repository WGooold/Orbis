import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_VIEW_CLOSE_CAPABILITY, RuntimeEventSchema, type RuntimeCommand, type RuntimeEvent } from "@orbis/protocol";
import { expect, it, vi } from "vitest";
import { OpenCodeBackend } from "./opencode-backend.js";
import { createOpenCodeLocalLauncher, prepareOpenCodeTerminalLaunch } from "./opencode-local-launch.js";
import { OPENCODE_CLIENT_VERSION, openCodeTerminalService, OpenCodeServiceConnection } from "./opencode-service-connection.js";

const exec = promisify(execFile);
const binary = process.env.ORBIS_OPENCODE_TEST_BINARY;
const version = OPENCODE_CLIENT_VERSION;

async function fixtureCli(root: string): Promise<string> {
  const bin = join(root, "fixture-bin");
  await mkdir(bin);
  if (process.platform === "win32") await copyFile(resolve(binary!), join(bin, "opencode.exe"));
  else await symlink(resolve(binary!), join(bin, "opencode"));
  return bin;
}

// HOST-AGENT-START-01: startup uses the released CLI's shared service and leaves that exact service usable after Host detach.
it.skipIf(!binary)("cold starts the native OpenCode service once and reuses it after Host detach", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbis-opencode-start-native-"));
  const home = join(root, "home"), registrationPath = join(root, "state", "opencode", "service.json");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key)));
  const env = { ...inherited, HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_SIMULATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", PATH: await fixtureCli(root) };
  // Reserve a fixture port in the native service config; the launch itself never substitutes a random endpoint.
  const testServer = (await import("node:net")).createServer();
  await new Promise<void>(resolveListen => testServer.listen(0, "127.0.0.1", resolveListen));
  const { port } = testServer.address() as import("node:net").AddressInfo;
  await new Promise<void>((resolveClose, reject) => testServer.close(error => error ? reject(error) : resolveClose()));
  await mkdir(join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(env.XDG_CONFIG_HOME, "opencode", "service.json"), JSON.stringify({ port }), { mode: 0o600 });
  const connection = new OpenCodeServiceConnection({ registrationPath, launcher: createOpenCodeLocalLauncher(env) });
  const existing = new OpenCodeServiceConnection({ registrationPath });
  let pid: number | undefined;
  try {
    await connection.refresh();
    expect(connection.launchable).toBe(true);
    expect(connection.isReady).toBe(false);
    await Promise.all([connection.ensure(() => true, () => connection.isReady), connection.ensure(() => true, () => connection.isReady)]);
    const info = await connection.client!.server.info();
    expect(info.version).toBe(version);
    pid = info.pid;
    connection.close();
    await existing.refresh();
    expect((await existing.client!.server.info()).pid).toBe(pid);
  } finally {
    connection.close(); await connection.drainStartup(); existing.close();
    if (pid !== undefined) {
      process.kill(pid, "SIGTERM");
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 10_000 });
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);

it.skipIf(!binary)(`validates the native OpenCode ${version} shared service in isolation`, async () => {
  const temporary = resolve(tmpdir());
  const root = await mkdtemp(join(temporary, "orbis-opencode-native-"));
  if (dirname(resolve(root)) !== temporary) throw new Error("OpenCode test directory outside temporary root");
  const parent = await realpath(root);
  const work = join(parent, "work"), otherWork = join(parent, "other-work"), alias = join(parent, "work-alias");
  const home = join(root, "home"), state = join(root, "state"), temp = join(root, "tmp");
  const data = join(root, "data"), config = join(root, "config"), cache = join(root, "cache");
  const registrationPath = join(state, "opencode", "service.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key)));
  // Start a test fixture only. Never read the user's OpenCode state, config or provider credentials.
  Object.assign(env, { HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, APPDATA: config, LOCALAPPDATA: data, TMP: temp, TEMP: temp, TMPDIR: temp,
    XDG_STATE_HOME: state, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
    OPENCODE_SIMULATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_FILEWATCHER_DISABLE: "1" });
  const connection = new OpenCodeServiceConnection({ registrationPath, pollIntervalMs: 250 });
  const events: Array<{ id: string; event: RuntimeEvent }> = [];
  const backend = new OpenCodeBackend({ connection, hostId: "isolated-test", reconnectMs: 100,
    onRuntimeOnline() {}, onRuntimeOffline() {}, onCatalogChange() {}, onAvailabilityChange() {},
    onEvent(id, event) { events.push({ id, event: RuntimeEventSchema.parse(event) }); } });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  let spawnFailed = false;
  const timing = { timeout: 6_000, interval: 50 };
  try {
    await Promise.all([home, work, otherWork, state, temp, data, config, cache].map(dir => mkdir(dir)));
    await symlink(work, alias, process.platform === "win32" ? "junction" : "dir");
    backend.start();
    await expect(connection.refresh()).resolves.toEqual({ state: "unavailable", reason: "service_not_found" });
    child = spawn(resolve(binary!), ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: work, env, windowsHide: true, stdio: "ignore",
    });
    exited = new Promise(resolveExit => {
      child!.once("error", () => { spawnFailed = true; resolveExit(); });
      child!.once("exit", () => resolveExit());
    });
    await connection.start();
    await vi.waitFor(() => {
      expect(spawnFailed).toBe(false);
      expect(child!.exitCode).toBeNull();
      expect(connection.status).toEqual({ state: "ready", version });
      expect(backend.isReady()).toBe(true);
    }, timing);
    const client = connection.client!;
    const service = await client.server.info();
    expect(service).toMatchObject({ version, pid: child.pid });
    const serviceIdentity = connection.identity!;
    const native = await openCodeTerminalService(serviceIdentity, registrationPath);
    const controlSession = await client.session.create({ location: { directory: otherWork } });
    const listProjectSessions = async (cwd: string): Promise<string[]> => {
      const { stdout } = await exec(resolve(binary!), ["session", "list", "--format", "json", "--server", serviceIdentity.origin],
        { cwd, env: { ...env, OPENCODE_PASSWORD: native.password }, timeout: 15_000, maxBuffer: 1_000_000 });
      const value: unknown = JSON.parse(stdout);
      if (!Array.isArray(value)) throw new Error("Pinned OpenCode CLI did not return a JSON session array");
      return value.flatMap(row => row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string" ? [(row as { id: string }).id] : []);
    };

    const catalog = await backend.sessionConfiguration(work);
    const model = catalog.models.find(item => item.thinking.some(variant => variant.value !== "default"));
    const variant = model?.thinking.find(item => item.value !== "default");
    const alternate = catalog.models.find(item => item.value !== model?.value);
    if (!model || !variant || !alternate) throw new Error("Pinned OpenCode fixture did not expose the expected test models");
    // OPENCODE-TUI-02: the App may select an alias, but native TUI lists the physical directory.
    const activation = await backend.activate({ type: "new", cwd: alias }, { configuration: { model: model.value } });
    const sessionID = activation.sessionId;
    if (!sessionID) throw new Error("OpenCode did not return the native session identity");
    expect((await client.session.get({ sessionID })).location.directory).toBe(work);
    const id = `opencode:${sessionID}`;
    await expect(backend.activate({ type: "resume", sessionId: sessionID })).resolves.toEqual(activation);
    expect(await backend.catalog()).toContainEqual(expect.objectContaining({ sessionId: sessionID, agentKind: "opencode" }));
    const [appProjectSessions, desktopProjectSessions] = await Promise.all([listProjectSessions(work), listProjectSessions(otherWork)]);
    expect(appProjectSessions).toContain(sessionID);
    expect(desktopProjectSessions).toContain(controlSession.id);
    expect(desktopProjectSessions).not.toContain(sessionID);
    await backend.setArchived(sessionID, true);
    expect(await backend.catalog(true)).toContainEqual(expect.objectContaining({ sessionId: sessionID, archived: true }));
    await backend.setArchived(sessionID, false);
    expect(await backend.catalog()).toContainEqual(expect.objectContaining({ sessionId: sessionID, archived: false }));

    const saw = (predicate: (event: RuntimeEvent) => boolean) => events.some(row => row.id === id && predicate(row.event));
    const dispatch = async (commandId: string, command: RuntimeCommand, status = "success") => {
      expect(backend.dispatchCommand(id, commandId, command)).toBe("handled");
      await vi.waitFor(() => expect(events.find(row => row.id === id && row.event.type === "command.result" && row.event.commandId === commandId)?.event)
        .toMatchObject({ type: "command.result", status }), timing);
    };
    await dispatch("alternate", { type: "slash.execute", name: "model", args: alternate.value });
    const selected = (await client.session.get({ sessionID })).model;
    expect(JSON.stringify([selected?.providerID, selected?.id])).toBe(alternate.value);
    await dispatch("model", { type: "slash.execute", name: "model", args: model.value });
    await dispatch("variant", { type: "slash.execute", name: "thinking", args: variant.value });
    expect((await client.session.get({ sessionID })).model?.variant).toBe(variant.value);
    const agent = (await client.agent.list({ location: { directory: work } })).data.find(item => !item.hidden && item.mode !== "subagent");
    if (!agent) throw new Error("Pinned OpenCode fixture did not expose a primary agent");
    await dispatch("agent", { type: "slash.execute", name: "agent", args: agent.id });
    expect((await client.session.get({ sessionID })).agent).toBe(agent.id);
    await dispatch("idle-stop", { type: "stop" }, "not_cancelable");

    await dispatch("prompt", { type: "user_message", messageId: "app-fixture", text: "Isolated Orbis test input" });
    // Reading persisted history preserves the App's original message identity.
    await vi.waitFor(async () => {
      const messages = (await client.message.list({ sessionID, type: "user" })).data;
      const native = messages.find(item => item.type === "user" && item.metadata?.["orbis.clientMessageId"] === "app-fixture");
      expect(native).toBeDefined();
      expect(await backend.readSessionEntry(id, sessionID, native!.id)).toMatchObject({ data: { message: { clientMessageId: "app-fixture" } } });
    }, timing);
    // Simulation deliberately has no model-provider controller. Stop a native turn if it is still running.
    if (Object.hasOwn(await client.session.active(), sessionID)) await dispatch("active-stop", { type: "stop" });
    await vi.waitFor(async () => expect(Object.hasOwn(await client.session.active(), sessionID)).toBe(false), timing);

    const queued = await client.session.prompt({ sessionID, text: "Isolated queued input", delivery: "queue", resume: false });
    await vi.waitFor(() => expect(saw(event => event.type === "message.queued" && event.queueId === queued.id && event.state === "accepted")).toBe(true), timing);
    await dispatch("cancel-queue", { type: "user_message.cancel", messageId: queued.id }, "cancelled");
    expect(await client.session.inbox.list({ sessionID })).not.toContainEqual(expect.objectContaining({ id: queued.id }));
    const form = await client.session.form.create({ sessionID, title: "Isolated questionnaire",
      fields: [{ key: "proceed", type: "boolean", required: true }, { key: "count", type: "integer", required: true }] });
    await vi.waitFor(() => expect(saw(event => event.type === "interaction.requested" && event.request.requestId === form.id)).toBe(true), timing);
    await dispatch("reply-form", { type: "interaction.respond", extensionId: "opencode.form", requestId: form.id,
      response: { kind: "questionnaire", answers: [{ id: "proceed", values: ["true"] }, { id: "count", values: [], other: "3" }] } });
    expect((await client.session.form.get({ sessionID, formID: form.id })).state).toMatchObject({ status: "answered", answer: { proceed: true, count: 3 } });

    const capabilities = [...events].reverse().find(row => row.id === id && row.event.type === "runtime.capabilities")?.event;
    if (capabilities?.type !== "runtime.capabilities") throw new Error("OpenCode did not publish its view-close capability");
    const closeGeneration = capabilities.capabilities.commands.find(command => command.name === RUNTIME_VIEW_CLOSE_CAPABILITY)?.closeGeneration;
    if (!closeGeneration) throw new Error("OpenCode did not publish a view-close generation");
    await dispatch("app-quit", { type: "session.close", sessionId: sessionID, confirmed: true, closeGeneration });
    expect(backend.directoryEntries()).toEqual([]);
    expect((await client.session.get({ sessionID })).id).toBe(sessionID);
    expect((await client.message.list({ sessionID, type: "user" })).data).toContainEqual(expect.objectContaining({
      text: "Isolated Orbis test input", metadata: expect.objectContaining({ "orbis.clientMessageId": "app-fixture" }),
    }));
    expect(await listProjectSessions(work)).toContain(sessionID);

    // OPENCODE-TUI-01: use the same native selection after the App view has detached.
    const newerChild = await client.session.create({ parentID: sessionID, location: { directory: work } });
    const archive = await client.session.create({ location: { directory: work } });
    await client.session.update({ sessionID: archive.id, archived: true });
    expect(new Set([sessionID, newerChild.id, archive.id]).size).toBe(3);
    const target = { sessionId: sessionID, directory: work, workspace: work, service: serviceIdentity };
    await expect(backend.latestSessionInDirectory(`${work}/.`)).resolves.toEqual({ sessionId: sessionID, directory: work, workspace: work });
    await expect(backend.latestSessionInDirectory(alias)).resolves.toEqual({ sessionId: sessionID, directory: work, workspace: work });
    await expect(backend.latestSessionInDirectory(otherWork)).resolves.toEqual({ sessionId: controlSession.id, directory: otherWork, workspace: otherWork });
    const legacy = await client.session.create({ location: { directory: alias } });
    expect(legacy.location.directory).toBe(alias);
    await expect(backend.latestSessionInDirectory(alias)).resolves.toEqual({ sessionId: legacy.id, directory: alias, workspace: work });
    await expect(backend.latestSessionInDirectory(work)).resolves.toEqual({ sessionId: sessionID, directory: work, workspace: work });
    const isolatedPath = await fixtureCli(root);
    const launch = await prepareOpenCodeTerminalLaunch(target, AbortSignal.timeout(8_000), { ...env, PATH: isolatedPath,
      OPENCODE_PASSWORD: "must-not-serialize-test-password", NODE_OPTIONS: "must-not-serialize-test-node-options" });
    expect(launch.environment.XDG_STATE_HOME).toBe(state);
    expect(launch.environment).not.toHaveProperty("OPENCODE_PASSWORD");
    expect(launch.environment).not.toHaveProperty("NODE_OPTIONS");
    expect(JSON.parse(Buffer.from(launch.args[1]!, "base64url").toString("utf8"))).toEqual({ target, cliCommand: {
      command: join(isolatedPath, process.platform === "win32" ? "opencode.exe" : "opencode"), prefixArgs: [],
    } });

    backend.close();
    connection.close();
    const next = new OpenCodeServiceConnection({ registrationPath });
    try {
      await expect(next.refresh()).resolves.toEqual({ state: "ready", version });
      expect((await next.client!.server.info()).pid).toBe(service.pid);
      expect((await next.client!.session.get({ sessionID })).id).toBe(sessionID);
    } finally { next.close(); }
  } finally {
    backend.close();
    connection.close();
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
