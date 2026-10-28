import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_INPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 540_000;

const input = await readStdin();
const hookEvent = typeof input?.hook_event_name === "string" ? input.hook_event_name : input?.event_name;

try {
  if (hookEvent !== "PermissionRequest" && hookEvent !== "PreToolUse") {
    write({});
  } else {
    const descriptor = await readDescriptor();
    const response = await fetch(`${descriptor.url}/v1/claude/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Orbis Host returned HTTP ${response.status}`);
    const result = await response.json();
    if (hookEvent === "PermissionRequest") {
      const behavior = result?.hookSpecificOutput?.decision?.behavior;
      if (behavior !== "allow" && behavior !== "deny") throw new Error("Orbis Host returned no PermissionRequest decision");
    } else {
      const output = result?.hookSpecificOutput;
      if (output?.permissionDecision !== "allow" && output?.permissionDecision !== "deny") {
        throw new Error("Orbis Host returned no PreToolUse decision");
      }
    }
    write(result);
  }
} catch (error) {
  process.stderr.write(`Orbis Claude Hook bridge: ${error instanceof Error ? error.message : String(error)}\n`);
  write(failClosed(hookEvent));
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_INPUT_BYTES) throw new Error("Claude Hook input exceeds 256 KiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Claude Hook input is not valid JSON"); }
}

async function readDescriptor() {
  const stateDir = process.env.ORBIS_STATE_DIR;
  const path = stateDir === undefined || stateDir.length === 0
    ? join(homedir(), ".pi-remote", "loopback.json")
    : join(stateDir, "loopback.json");
  const descriptor = JSON.parse(await readFile(path, "utf8"));
  if (typeof descriptor.url !== "string" || !/^ws:\/\/127\.0\.0\.1:\d+$/u.test(descriptor.url) ||
      typeof descriptor.token !== "string" || descriptor.token.length < 16) {
    throw new Error("Host loopback descriptor is invalid");
  }
  return { url: descriptor.url.replace(/^ws:/u, "http:"), token: descriptor.token };
}

function failClosed(eventName) {
  if (eventName === "PermissionRequest") return {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Orbis Host did not return an approval" } },
  };
  if (eventName === "PreToolUse") return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Orbis Host did not return an answer" },
  };
  return {};
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
