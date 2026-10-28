// Real desktop app-server regression. Run after npm run build.
// Creates one dedicated thread, or observes --watch-thread without starting a turn.
// Both modes attach once and never request a second preview to repair the baseline.
// Example: node scripts/test-codex-question-sync.mjs --watch-thread <id> --marker <prefix>
// Add --reactivate-after-question in dedicated-thread mode to reproduce source reset on resume.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { resolveStateDir } from "../packages/e2e/dist/index.js";
import { CodexAppServer } from "../packages/host/dist/codex-daemon.js";
import { readCodexDesktopEndpoint } from "../packages/host/dist/codex-desktop-launcher.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const root = resolve(import.meta.dirname, "../.scratch/codex-question-sync");
const workspace = join(root, "workspace");
const output = resolve(option("--output", join(root, "result.json")));
const endpointFile = option("--endpoint-file", join(resolveStateDir(), "codex-desktop-endpoint.json"));
const timeoutMs = Number(option("--timeout-ms", "180000"));
const watchThread = option("--watch-thread");
const reactivateAfterQuestion = args.includes("--reactivate-after-question");
const answerDelayMs = Number(option("--answer-delay-ms", "5000"));
const marker = option("--marker", `ORBIS_QUESTION_SYNC_${randomUUID().replaceAll("-", "")}`);
const expectedMarkers = option("--message-markers", `${marker}_AFTER_ANSWER,${marker}_FINAL`).split(",");
const containsMarker = text => expectedMarkers.some(value => text.includes(value));
const runtimeDirectory = resolve(option("--runtime-dir", join(import.meta.dirname, "../packages/host/dist")));
const [{ CodexRuntime, CODEX_SOURCE_COALESCE_MS }, { AgentConversationState }, { AgentStateFacts }, { AgentStateRegistry }] = await Promise.all(
  ["codex-runtime.js", "agent-conversation-state.js", "agent-state-facts.js", "agent-state-registry.js"]
    .map(file => import(pathToFileURL(join(runtimeDirectory, file)).href)));
const trace = [];
const rejects = [];
const events = [];
let driver, observer, runtime, threadId, turnId;
let question;
let answeredAt;
let turnCompleted = false;
let activateCalls = 0;
let syncCalls = 0;
let nativeQuestion;
let runError;

const record = (kind, fields = {}) => {
  const row = { at: Date.now(), kind, ...fields };
  trace.push(row);
  if (["connected", "thread_created", "prompt_sent", "watching", "question", "reactivated", "answer_sent", "after_answer", "completed"].includes(kind)) {
    process.stdout.write(JSON.stringify(row) + "\n");
  }
};
const waitFor = async (predicate, description, budget = timeoutMs) => {
  const deadline = Date.now() + budget;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    if (turnCompleted && description === "native asynchronous question") {
      throw new Error("Codex completed its turn without producing the requested native async question");
    }
    await delay(50);
  }
};
const object = value => value && typeof value === "object" ? value : {};
const messageText = message => (message?.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []).join("");

const registry = new AgentStateRegistry();
const facts = new AgentStateFacts({ registry, hostId: "question-sync-test", kindOf: () => "codexDesktop" });
const model = new AgentConversationState(registry);
let scope;
const onEvent = event => {
  events.push(event);
  if (event.type === "interaction.requested" && event.request.kind === "questionnaire") {
    question ??= event.request;
    record("question", { requestId: event.request.requestId, titles: event.request.questions.map(q => q.question) });
  }
  if (event.type === "interaction.resolved") {
    record("question_resolved", { requestId: event.requestId, source: event.source });
  }
  if (event.type === "message.finished" && event.message.role === "assistant" && containsMarker(messageText(event.message))) {
    record("marker_finished", { messageId: event.message.messageId, text: messageText(event.message) });
  }
  if (event.type === "session.patch" || event.type === "session.snapshot") {
    const accepted = model.accept(scope, event,
      ready => facts.prepareConversation(`codex-desktop:${threadId}`, event, ready),
      reason => { rejects.push(reason); record("rejected", { reason }); });
    record("conversation", { type: event.type, accepted, source: event.source,
      head: event.head ?? event.checkpoint?.head,
      entries: (event.entries ?? []).map(e => e.entryId),
      liveComplete: event.live?.complete, modelBaselineReady: model.hasBaseline(scope),
      texts: (event.live?.messages ?? []).map(item => ({ id: item.message.messageId,
        text: containsMarker(messageText(item.message)) ? messageText(item.message) : undefined })) });
  } else {
    facts.observe(`codex-desktop:${threadId}`, event);
  }
};

try {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "--timeout-ms must be positive");
  assert.ok(Number.isFinite(answerDelayMs) && answerDelayMs >= 0, "--answer-delay-ms must not be negative");
  assert.ok(expectedMarkers.length >= 2 && expectedMarkers.every(value => value.length > 0), "At least two nonempty message markers are required");
  assert.equal(new Set(expectedMarkers).size, expectedMarkers.length, "Message markers must be distinct");
  assert.ok(!watchThread || !reactivateAfterQuestion, "Reactivation is only allowed on a dedicated test thread");
  await mkdir(workspace, { recursive: true });
  const endpoint = readCodexDesktopEndpoint(endpointFile);
  assert.ok(endpoint, `No running desktop app-server descriptor at ${endpointFile}`);
  driver = await CodexAppServer.createExternal({ endpoint: endpoint.url, clientName: "orbis-question-sync-desktop" });
  observer = await CodexAppServer.createExternal({ endpoint: endpoint.url, clientName: "orbis-question-sync-observer" });
  record("connected");

  const started = watchThread
    ? await driver.request("thread/resume", { threadId: watchThread })
    : await driver.request("thread/start", { cwd: workspace, approvalPolicy: "never", sandbox: "workspace-write" });
  threadId = object(started.thread).id;
  assert.equal(typeof threadId, "string", "thread/start must return a thread ID");
  record("thread_created", { threadId, model: started.model });
  scope = { kind: "agent", key: { hostId: "question-sync-test", agentKind: "codexDesktop", sessionId: `codex-desktop:${threadId}` } };

  const nativeNotify = observer.onNotification;
  runtime = new CodexRuntime({ server: observer, rolloutRoot: join(root, "no-user-rollouts"),
    sourceCoalesceMs: CODEX_SOURCE_COALESCE_MS, onEvent });
  const runtimeNotify = observer.onNotification;
  const observeNative = (source, method, params) => {
    const data = object(params);
    if (data.threadId === threadId || object(data.thread).id === threadId) {
      record("native", { source, method, turnId: data.turnId ?? object(data.turn).id,
        itemId: object(data.item).id ?? data.itemId, itemType: object(data.item).type,
        phase: object(data.item).phase, status: object(data.turn).status ?? object(data.status).type });
      const item = object(data.item);
      if (Array.isArray(item.questions) && item.questions.length) nativeQuestion = item;
      if (method === "turn/completed") turnCompleted = true;
    }
  };
  driver.onNotification = (method, params) => observeNative("desktop", method, params);
  observer.onNotification = (method, params) => {
    observeNative("host", method, params);
    (runtimeNotify ?? nativeNotify)?.(method, params);
  };
  driver.onServerRequest = request => {
    record("server_request", { method: request.method });
  };
  runtime.seedDesktopThreads([threadId]);
  const prompt = [
    "This is an authorized, isolated Orbis desktop question synchronization regression test.",
    "Do not inspect the repository, read files, use browser/network tools, or change any files.",
    "Use the native request_user_input_async tool exactly once now. Ask: 'Orbis sync test: choose a letter' with options A and B.",
    "The test client will submit A from another desktop client while your turn is still running.",
    "After asking, output ORBIS_BEFORE_ANSWER, then wait for the answer by sleeping in short intervals if necessary. Keep the same turn running for at least 20 seconds so the client can answer.",
    `Once the answer arrives, output ${marker}_AFTER_ANSWER as an assistant message, perform one short local sleep, and then output ${marker}_FINAL as your final response.`,
    "Do not ask a second question. Do not require another ordinary user message to continue.",
  ].join("\n");
  if (!watchThread) {
    const turn = await driver.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    turnId = object(turn.turn).id;
    record("prompt_sent", { threadId, turnId });
  }
  // A newly created native thread has no rollout until the first user message.
  // Attach once after turn/start materializes it, then keep that subscription.
  const materializeDeadline = Date.now() + 15000;
  while (true) {
    try {
      const history = await driver.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc", limit: 1 });
      if (Array.isArray(history.data) && history.data.length) break;
    } catch (error) {
      if (!/rollout|session metadata|materializ|not found/iu.test(String(error))) throw error;
    }
    if (Date.now() >= materializeDeadline) throw new Error("New native thread did not materialize its first turn");
    await delay(100);
  }
  activateCalls++;
  await runtime.activate({ type: "resume", sessionId: `codex-desktop:${threadId}` });
  const syncId = randomUUID();
  syncCalls++;
  runtime.handleCommand({ type: "session.sync", sessionId: `codex-desktop:${threadId}`, syncId,
    range: "preview", maxEntries: 30 }, syncId, threadId);
  await waitFor(() => events.some(event => event.type === "session.snapshot" && event.syncId === syncId), "initial preview", 15000);
  if (watchThread) {
    turnId = events.find(event => event.type === "session.snapshot" && event.syncId === syncId)?.live?.turn?.turnId;
    record("watching", { threadId, turnId, marker, expectedMarkers });
  }
  await waitFor(() => question && nativeQuestion, "native asynchronous question");
  if (reactivateAfterQuestion) {
    activateCalls++;
    await runtime.activate({ type: "resume", sessionId: `codex-desktop:${threadId}` });
    record("reactivated", { threadId, activateCalls });
  }
  const q = question.questions[0];
  const nativeIndex = Number(q.id);
  const envelope = `<send_user_message_question_reply>\n${JSON.stringify([{
    questionItemId: JSON.stringify(["request_user_input_async", nativeQuestion.id, nativeIndex]),
    question: q.question, answer: "A",
  }])}\n</send_user_message_question_reply>`;
  if (watchThread) {
    await waitFor(() => events.some(event => event.type === "interaction.resolved" && event.source === "local"), "manual desktop answer");
    answeredAt = Date.now();
  } else {
    await delay(answerDelayMs);
    answeredAt = Date.now();
    await driver.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: envelope }] });
  }
  record("answer_sent", { threadId, turnId });
  await waitFor(() => trace.some(row => row.kind === "conversation" && row.accepted && row.at >= answeredAt
    && row.texts?.some(item => item.text?.includes(expectedMarkers[0])))
    || trace.some(row => row.kind === "marker_finished" && row.at >= answeredAt && row.text.includes(expectedMarkers[0])),
  "assistant message after desktop answer");
  record("after_answer");
  if (watchThread) {
    await waitFor(() => trace.some(row => row.kind === "marker_finished" && row.at >= answeredAt && row.text.includes(expectedMarkers.at(-1))), "last test message");
  } else {
    await waitFor(() => turnCompleted, "native turn completion");
  }
  await delay(CODEX_SOURCE_COALESCE_MS + 100);
  assert.equal(activateCalls, reactivateAfterQuestion ? 2 : 1, "Only the explicitly requested test reactivation is allowed");
  assert.equal(syncCalls, 1, "No extra preview may repair the baseline during this regression");
  assert.deepEqual(rejects, [], "All conversation patches must be accepted by the real Host model");
  assert.ok(events.some(event => event.type === "interaction.resolved" && event.source === "local"), "Desktop answer must resolve the question");
  const finishedMarkers = expectedMarkers.map(value => trace.find(row => row.kind === "marker_finished" && row.at >= answeredAt && row.text.includes(value)));
  assert.ok(finishedMarkers.every(Boolean), "Every test marker must arrive after the desktop answer");
  assert.ok(finishedMarkers.every((row, index) => index === 0 || row.at >= finishedMarkers[index - 1].at), "Test markers must arrive in order");
  const finalId = finishedMarkers.at(-1).messageId;
  const final = events.find(event => event.type === "message.finished" && event.message.messageId === finalId);
  assert.ok(final, "Final output must arrive without starting another turn");
  assert.ok(model.hasBaseline(scope), "Host conversation must still have a complete baseline");
  const historyHead = registry.read(scope, "history")?.value?.head.leafId;
  const live = registry.read(scope, "live")?.value;
  assert.ok(historyHead === final.message.messageId || live?.messages.some(item =>
    item.message.messageId === final.message.messageId && messageText(item.message).includes(expectedMarkers.at(-1))),
  "Host's accepted history or active-turn live state must contain the final assistant message");
  record("completed", { passed: true,
    acceptedAfterAnswer: trace.filter(row => row.kind === "conversation" && row.accepted && row.at >= answeredAt).length,
    markers: finishedMarkers.map(row => ({ messageId: row.messageId, at: row.at })),
    finalMessageId: final.message.messageId, historyHead, finalInLive: live?.messages.some(item => item.message.messageId === final.message.messageId) });
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  process.stderr.write(runError + "\n");
  process.exitCode = 1;
} finally {
  if (!watchThread && driver && threadId && turnId && !turnCompleted) {
    await driver.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  }
  if (runtime) await runtime.stop();
  else await observer?.stop();
  await driver?.stop();
  await mkdir(dirname(output), { recursive: true });
  const result = { passed: runError === undefined, error: runError, threadId, turnId,
    desktopAppServer: true, watchOnly: Boolean(watchThread), reactivateAfterQuestion, runtimeDirectory, expectedMarkers,
    activateCalls, syncCalls, answeredAt, turnCompleted,
    rejectedConversationPatches: rejects, userHostRestarted: false, trace };
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: result.passed, error: runError, output, threadId, activateCalls, syncCalls }) + "\n");
}
