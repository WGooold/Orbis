import { createInterface } from "node:readline";
import { DesktopRuntime, type DesktopSettings } from "./desktop-runtime.js";
import { ProviderError } from "./provider-manager.js";
import { join } from "node:path";

// stdout is exclusively a JSON-lines pipe to the parent Qt process. Host diagnostics use events or stderr.
const output = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
console.log = (...values: unknown[]) => console.error(...values);
const providerTestRoot = process.env.ORBIS_PROVIDER_TEST_ROOT;
const runtime = new DesktopRuntime(output, process.env.ORBIS_HOST_STATE_DIR, providerTestRoot ? { codex: join(providerTestRoot, "codex"), pi: join(providerTestRoot, "pi"), dsh: join(providerTestRoot, "dsh") } : undefined);
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
        case "install": result = await runtime.install(String(p.kind), String(p.version ?? "latest")); break;
        case "provider.list": result = await runtime.listProviders(String(p.kind)); break;
        case "provider.get": result = await runtime.getProvider(String(p.kind), String(p.id)); break;
        case "provider.draft": result = await runtime.providerDraft(String(p.kind), p.id ? String(p.id) : undefined, p.presetId ? String(p.presetId) : undefined); break;
        case "provider.presets": result = runtime.providerPresets(String(p.kind)); break;
        case "provider.preview": result = runtime.providerPreview(p); break;
        case "provider.codexPreferences": result = await runtime.codexPreferences(); break;
        case "provider.saveCodexPreferences": result = await runtime.saveCodexPreferences(p); break;
        case "provider.piDefault": result = await runtime.piDefaultProvider(); break;
        case "provider.check": result = await runtime.checkProvider(String(p.kind), String(p.id)); break;
        case "provider.models": result = await runtime.fetchProviderModels(p); break;
        case "provider.usage": result = await runtime.queryProviderUsage(String(p.kind), String(p.id)); break;
        case "provider.saveUsage": await runtime.saveProviderUsage(String(p.kind), String(p.id), p.script); break;
        case "provider.usageTemplate": result = await runtime.providerUsageTemplate(String(p.kind), String(p.id), String(p.template), String(p.baseUrl ?? "")); break;
        case "provider.oauth": result = await runtime.oauth(String(p.operation), String(p.accountId ?? "")); break;
        case "provider.open": await runtime.openProvider(String(p.kind), String(p.id)); break;
        case "provider.save": result = await runtime.mutateProvider(String(p.kind), "save", p); break;
        case "provider.switch": result = await runtime.mutateProvider(String(p.kind), "switch", p); break;
        case "provider.remove": result = await runtime.mutateProvider(String(p.kind), "remove", p); break;
        case "provider.copy": result = await runtime.mutateProvider(String(p.kind), "copy", p); break;
        case "openAgent": await runtime.openAgent(String(p.kind), p.mode === undefined ? "setup" : String(p.mode)); break;
        case "shutdown": await runtime.close(); closing = true; break;
        default: throw new Error("Unknown desktop command");
      }
      output({ id: request.id, result });
      if (closing) process.exit(0);
    } catch (error) { output({ id: request?.id ?? 0, error: request?.method.startsWith("provider.") && !(error instanceof ProviderError) ? "供应商操作失败，请检查配置格式与文件权限" : error instanceof Error ? error.message : String(error) }); }
  });
});
input.on("close", () => { runtime.cancelInstall(); void commands.finally(async () => { await runtime.close(); process.exit(0); }); });
process.on("SIGTERM", () => { void runtime.close().finally(() => process.exit(0)); });
