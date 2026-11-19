import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RuntimeEventSchema, type RuntimeCommand, type RuntimeEvent } from "@orbis/protocol";
import { expect, it, vi } from "vitest";
import { OpenCodeBackend } from "./opencode-backend.js";
import { OPENCODE_CLIENT_VERSION, OpenCodeServiceConnection } from "./opencode-service-connection.js";

const binary = process.env.ORBIS_OPENCODE_TEST_BINARY;
const version = OPENCODE_CLIENT_VERSION;

it.skipIf(process.platform !== "win32" || !binary)(`validates the Windows OpenCode ${version} shared service in isolation`, async () => {
  const temporary = resolve(tmpdir());
  const root = await mkdtemp(join(temporary, "orbis-opencode-native-"));
  const home = join(root, "home"), work = join(root, "work"), state = join(root, "state"), temp = join(root, "tmp");
  const data = join(root, "data"), config = join(root, "config"), cache = join(root, "cache");
  const registrationPath = join(state, "opencode", "service.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|comspec|pathext)$/i.test(key)));
  // Start a test fixture only. Never read the user's OpenCode state, config or provider credentials.
  Object.assign(env, { HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home, APPDATA: config, LOCALAPPDATA: data, TMP: temp, TEMP: temp,
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
    await Promise.all([home, work, state, temp, data, config, cache].map(dir => mkdir(dir)));
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

    const catalog = await backend.sessionConfiguration(work);
    const model = catalog.models.find(item => item.thinking.some(variant => variant.value !== "default"));
    const variant = model?.thinking.find(item => item.value !== "default");
    const alternate = catalog.models.find(item => item.value !== model?.value);
    if (!model || !variant || !alternate) throw new Error("Pinned OpenCode fixture did not expose the expected test models");
    const activation = await backend.activate({ type: "new", cwd: work }, { configuration: { model: model.value } });
    const sessionID = activation.sessionId;
    if (!sessionID) throw new Error("OpenCode did not return the native session identity");
    const id = `opencode:${sessionID}`;
    await expect(backend.activate({ type: "resume", sessionId: sessionID })).resolves.toEqual(activation);
    expect(await backend.catalog()).toContainEqual(expect.objectContaining({ sessionId: sessionID, agentKind: "opencode" }));
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
    if (dirname(resolve(root)) !== temporary) throw new Error("OpenCode test directory outside temporary root");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
