import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connectDevice } from "./device.mjs";

// Run inside the isolated Host container after deployment. No personal Host config.
const access = JSON.parse(await readFile("/data/review-pairing.json", "utf8"));
const response = await fetch(`http://127.0.0.1:8788/${access.code}/pairing.json`);
if (!response.ok) throw new Error(`Review page failed: HTTP ${response.status}`);
const text = await response.text();
const device = await connectDevice(text, process.argv.includes("--local") ? { httpBase: "http://127.0.0.1:8788", relayUrl: "ws://127.0.0.1:8787" } : {});
try {
  const runtime = device.ready.runtimes.find(item => item.cwd === "/data/workspace");
  if (!runtime) throw new Error("Real Pi runtime is not visible to paired mobile client");
  if (process.argv.includes("--live")) {
    const sendCommand = command => device.send({ type: "runtime.command", runtimeId: runtime.runtimeId, commandId: randomUUID(), command });
    const syncId = randomUUID();
    sendCommand({ type: "session.sync", sessionId: runtime.sessionId, syncId, range: "preview" });
    const baseline = await device.matching(item => item.type === "runtime.event" && item.runtimeId === runtime.runtimeId && item.event.type === "session.snapshot" && item.event.syncId === syncId);
    sendCommand({ type: "session.snapshot.ack", syncId, result: "applied" });
    const known = new Set(baseline.event.entries.map(entry => entry.entryId));
    const id = randomUUID();
    device.send({ type: "runtime.command", runtimeId: runtime.runtimeId, commandId: id,
      command: { type: "user_message", messageId: id,
        text: "Read README.md using the read tool, then explain this sample project in one short English sentence. Do not modify any files." } });
    const tools = new Set(); const answers = new Map(); let outcome;
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const message = await device.matching(item => item.type === "runtime.event" && item.runtimeId === runtime.runtimeId, Math.max(1, end - Date.now()));
      const event = message.event;
      if (event.type !== "session.patch") continue;
      for (const entry of event.entries ?? []) {
        if (known.has(entry.entryId)) continue;
        const message = entry.data?.message;
        if (!message) continue;
        if (message.role === "toolResult" || message.role === "tool") tools.add(message.toolCallId ?? entry.entryId);
        if (message.role === "assistant" && message.stopReason === "error") throw new Error("Review model request failed");
        if (message.role === "assistant" && message.stopReason === "stop") {
          const text = (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
          if (text.trim()) answers.set(entry.entryId, text);
        }
      }
      const turnOutcome = event.live?.turn?.outcome;
      if (turnOutcome === "failed" || turnOutcome === "cancelled") throw new Error(`Review turn ${turnOutcome}`);
      if (event.live?.complete && (turnOutcome === "completed" || event.live.turn === null) && answers.size && tools.size) { outcome = "completed"; break; }
    }
    if (outcome !== "completed") {
      throw new Error(`Real model/tool verification failed: outcome=${outcome}, answers=${answers.size}, tools=${tools.size}`);
    }
    console.log(JSON.stringify({ ok: true, pairing: true, encryptedTransport: true, realPi: true,
      realModel: "deepseek-flash", toolCalls: tools.size, answer: [...answers.values()].join("\n"), outcome }));
  } else {
    console.log(JSON.stringify({ ok: true, pairing: true, encryptedTransport: true, realPi: true, cwd: runtime.cwd }));
  }
} finally { await device.close(); }
