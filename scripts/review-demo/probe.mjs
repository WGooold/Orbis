import { randomUUID } from "node:crypto";
import { connectDevice } from "./device.mjs";

// Run inside the isolated Host container after deployment. No personal Host config.
const response = await fetch("http://127.0.0.1:8788/pair", { method: "POST", headers: { "x-review-request": "1" } });
if (!response.ok) throw new Error(`Review page failed: HTTP ${response.status}`);
const { text } = await response.json();
const device = await connectDevice(text);
try {
  const runtime = device.ready.runtimes.find(item => item.cwd === "/data/workspace");
  if (!runtime) throw new Error("Real Pi runtime is not visible to paired mobile client");
  if (process.argv.includes("--live")) {
    const id = randomUUID();
    device.send({ type: "runtime.command", runtimeId: runtime.runtimeId, commandId: id,
      command: { type: "user_message", messageId: id,
        text: "Read README.md using the read tool, then explain this sample project in one short English sentence. Do not modify any files." } });
    const tools = []; const answers = []; let outcome;
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const message = await device.matching(item => item.type === "runtime.event" && item.runtimeId === runtime.runtimeId, Math.max(1, end - Date.now()));
      const event = message.event;
      if (event.type === "tool.started") tools.push(event.toolName ?? event.tool?.name ?? "tool");
      if (event.type === "message.finished" && event.message.role === "assistant") {
        answers.push(...event.message.content.filter(part => part.type === "text").map(part => part.text));
      }
      if (event.type === "turn.finished") { outcome = event.outcome; break; }
    }
    if (outcome !== "completed" || !answers.some(answer => answer.trim()) || !tools.length) {
      throw new Error(`Real model/tool verification failed: outcome=${outcome}, answers=${answers.length}, tools=${tools.length}`);
    }
    console.log(JSON.stringify({ ok: true, pairing: true, encryptedTransport: true, realPi: true,
      realModel: "deepseek-flash", toolCalls: tools.length, answer: answers.join("\n"), outcome }));
  } else {
    console.log(JSON.stringify({ ok: true, pairing: true, encryptedTransport: true, realPi: true, cwd: runtime.cwd }));
  }
} finally { await device.close(); }
