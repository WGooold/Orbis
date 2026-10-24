// Run after npm run build. Uses its own app-server, CODEX_HOME and workspace.
// Never sends a user message, calls a model, or opens a terminal window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer } from "../packages/host/dist/codex-daemon.js";
import { CodexRuntime } from "../packages/host/dist/codex-runtime.js";

const repo = resolve(import.meta.dirname, "..");
const output = process.argv[2] ? resolve(process.argv[2]) : undefined;
await mkdir(join(repo, ".scratch"), { recursive: true });
const root = await mkdtemp(join(repo, ".scratch", "codex-empty-history-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const events = [];
const methods = [];
let server;
let runtime;
const waitFor = async (predicate, description) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
};
process.env.PI_REMOTE_CODEX_HEAD = "0";
try {
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(join(home, "config.toml"), 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n');
  server = await CodexAppServer.create({
    requestTimeoutMs: 15_000,
    spawnImpl: (command, args) => spawn(command, args, {
      env: { ...process.env, CODEX_HOME: home }, cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }),
  });
  const nativeRequest = server.request.bind(server);
  server.request = (method, ...args) => {
    methods.push(method);
    assert.notEqual(method, "turn/start", "This regression must never call a model");
    return nativeRequest(method, ...args);
  };
  runtime = new CodexRuntime({ server, rolloutRoot: join(home, "sessions"),
    onEvent: event => events.push(event), sourceCoalesceMs: 0 });
  runtime.markStarted();
  const { sessionId } = await runtime.activate({ type: "new", cwd: workspace });
  const preview = async id => {
    runtime.handleCommand({ type: "session.sync", sessionId, syncId: id, range: "preview", maxEntries: 30 }, id, sessionId);
    await waitFor(() => events.some(event => event.type === "command.result" && event.commandId === id), id);
    assert.equal(events.find(event => event.type === "command.result" && event.commandId === id).ok, true);
    const snapshot = events.find(event => event.type === "session.snapshot" && event.syncId === id);
    assert.ok(snapshot, "A new empty session must return a snapshot");
    assert.equal(snapshot.source.ready, true);
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.entries, []);
  };
  let nativeError;
  let nativeHistory;
  try {
    nativeHistory = await server.request("thread/turns/list", { threadId: sessionId, itemsView: "full", sortDirection: "asc", limit: 200 });
  } catch (error) { nativeError = error; }
  if (nativeError) {
    assert.ok(nativeError instanceof Error);
    assert.match(nativeError.message, /not materialized yet; thread\/turns\/list is unavailable before first user message/u);
  } else assert.deepEqual(nativeHistory.data, []);
  await preview("initial-empty-preview");
  const readsBefore = methods.filter(method => method === "thread/turns/list").length;
  runtime.announce(sessionId);
  await waitFor(() => methods.filter(method => method === "thread/turns/list").length > readsBefore, "empty-session native reconciliation");
  await preview("reconciled-empty-preview");
  const result = { passed: true, nativePreMessageRejectionReproduced: nativeError !== undefined,
    emptyPreviewsPassed: 2, nativeHistoryReads: methods.filter(method => method === "thread/turns/list").length,
    modelCalls: methods.filter(method => method === "turn/start").length,
    isolatedHome: true, userHostRestarted: false };
  if (output) {
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} finally {
  if (runtime) await runtime.stop();
  else if (server) await server.stop();
  await rm(root, { recursive: true, force: true });
}
