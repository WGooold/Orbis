import { parentPort, workerData } from "node:worker_threads";
import { getQuickJS } from "quickjs-emscripten";

// User code executes in QuickJS with no Node globals, filesystem or network bindings.
const data = workerData as { code: string; response?: unknown };
const engine = await getQuickJS();
const runtime = engine.newRuntime();
runtime.setMemoryLimit(16 * 1024 * 1024);
runtime.setMaxStackSize(256 * 1024);
const deadline = Date.now() + 5_000;
runtime.setInterruptHandler(() => Date.now() > deadline);
const context = runtime.newContext();
try {
  const script = `const usageConfig = eval(${JSON.stringify(data.code)}); JSON.stringify(${Object.hasOwn(data, "response") ? `usageConfig.extractor(${JSON.stringify(data.response)})` : "usageConfig.request"})`;
  const result = context.evalCode(script);
  if (result.error) { result.error.dispose(); throw new Error("script"); }
  const output = context.getString(result.value); result.value.dispose();
  if (output.length > 64_000) throw new Error("size");
  parentPort?.postMessage({ result: JSON.parse(output) as unknown });
} catch { parentPort?.postMessage({ error: "用量脚本执行失败，或超过时间、内存限制" }); }
finally { context.dispose(); runtime.dispose(); }
