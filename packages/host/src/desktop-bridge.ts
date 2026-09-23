import { createInterface } from "node:readline";
import { DesktopRuntime, type DesktopSettings } from "./desktop-runtime.js";

// stdout is exclusively a JSON-lines pipe to the parent Qt process. Host diagnostics use events or stderr.
const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
console.log = (...values: unknown[]) => console.error(...values);
const runtime = new DesktopRuntime(output, process.env.ORBIS_HOST_STATE_DIR);
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let commands = Promise.resolve();
let closing = false;
input.on("line", line => {
  if (line.length > 65_536) return;
  try { if ((JSON.parse(line) as { method?: string }).method === "shutdown") runtime.cancelInstall(); } catch { /* Normal request handling reports malformed JSON below. */ }
  commands = commands.then(async () => {
    let request: { id: number; method: string; params?: Record<string, unknown> } | undefined;
    try {
      request = JSON.parse(line) as typeof request;
      if (!request || !Number.isSafeInteger(request.id)) throw new Error("Invalid request");
      const p = request.params ?? {};
      let result: unknown = {};
      switch (request.method) {
        case "initialize": result = await runtime.initialize(); break;
        case "detect": result = await runtime.detect(p); break;
        case "start": await runtime.start(p as DesktopSettings); break;
        case "stop": await runtime.stop(); break;
        case "pair": result = await runtime.pair(); break;
        case "cancelPair": runtime.cancelPair(); break;
        case "revoke": await runtime.revoke(String(p.deviceId)); break;
        case "renameDevice": await runtime.renameDevice(String(p.deviceId), String(p.label)); break;
        case "rename": await runtime.renameHost(String(p.name)); break;
        case "install": await runtime.install(String(p.kind)); break;
        case "openAgent": await runtime.openAgent(String(p.kind), p.mode === undefined ? "setup" : String(p.mode)); break;
        case "shutdown": await runtime.close(); closing = true; break;
        default: throw new Error("Unknown desktop command");
      }
      output({ id: request.id, result });
      if (closing) process.exit(0);
    } catch (error) { output({ id: request?.id ?? 0, error: error instanceof Error ? error.message : String(error) }); }
  });
});
input.on("close", () => { runtime.cancelInstall(); void commands.finally(async () => { await runtime.close(); process.exit(0); }); });
process.on("SIGTERM", () => { void runtime.close().finally(() => process.exit(0)); });
