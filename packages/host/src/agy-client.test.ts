import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "@orbis/protocol";
import { AGY_VERSION, connectAgy, openAgyProfile, verifyAgyConnection } from "./agy-client.js";
import { AgyRuntime } from "./agy-runtime.js";
import { type AgyKeyCheck } from "./agy-credential.js";

// Exercise the subprocess boundary, including agent-initiated permission requests.
const fixture = (compatible: boolean, version = AGY_VERSION, methodId = "gemini-api-key") => ({ command: process.execPath, prefixArgs: ["-e", `
  const rl = require('node:readline').createInterface({input:process.stdin});
  const send = frame => console.log(JSON.stringify({jsonrpc:'2.0',...frame}));
  let pending;
  rl.on('line', line => {
    const row = JSON.parse(line);
    if (row.method === 'initialize') send({id:row.id,result:{protocolVersion:1,
      agentInfo:{version:${JSON.stringify(version)}}, agentCapabilities:{loadSession:${compatible}, sessionCapabilities:{list:{}}},
      authMethods:[{id:${JSON.stringify(methodId)}}]}});
    if (row.method === 'session/prompt') { pending = row.id; send({id:'permission',method:'session/request_permission',params:{}}); }
    if (row.id === 'permission') send({id:pending,result:row.result});
  });`, "--"] });

const isolatedKey = "fixture-only-not-a-key";
const replacementKey = "fixture-replacement-key";
const verified = async (): Promise<AgyKeyCheck> => "verified";

async function nativeFixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-agy-profile-"));
  const bin = join(root, "agy-fixture");
  const lock = join(root, "agy-acp", "owner.lock");
  const env = { ORBIS_AGY_ENTRY: bin, GEMINI_API_KEY: "ambient-not-for-this-child", ORBIS_RUNTIME_CREDENTIAL: "must-not-inherit",
    GOOGLE_GEMINI_BASE_URL: "https://wrong.invalid", GOOGLE_APPLICATION_CREDENTIALS: "/never/inherit", HOME: root };
  await writeFile(bin, `#!${process.execPath}
const rl = require('node:readline').createInterface({input:process.stdin});
const send = frame => console.log(JSON.stringify({jsonrpc:'2.0',...frame}));
let authenticated = false;
const key = process.env.GEMINI_API_KEY;
rl.on('line', line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    if (process.env.ORBIS_RUNTIME_CREDENTIAL || process.env.GOOGLE_GEMINI_BASE_URL || process.env.GOOGLE_APPLICATION_CREDENTIALS
       || !process.env.HOME.endsWith('/agy-acp/home') || !process.argv.includes('--sandbox') || process.argv.includes('--dangerously-skip-permissions')
       || !process.argv.includes(process.env.HOME+'/.gemini') || process.argv.includes(key)) process.exit(19);
    result = {protocolVersion:1,agentInfo:{version:'${AGY_VERSION}'},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{}}},authMethods:[{id:'gemini-api-key'}]};
  } else if (request.method === 'authenticate') {
    if (JSON.stringify(request.params) !== '{"methodId":"gemini-api-key"}' || !['${isolatedKey}','${replacementKey}'].includes(key)) process.exit(20);
    authenticated = true;
    result = {};
  } else if (!authenticated) process.exit(21);
  else if (request.method === 'session/list') result = {sessions:[]};
  else if (request.method === 'session/new') result = {sessionId:'fixture-native'};
  else if (request.method === 'session/prompt') {
    if (request.params.sessionId !== 'fixture-native') process.exit(22);
    const text = (key === '${replacementKey}' ? 'rotated' : 'original') + ' answer ' + key;
    // Only the sanitized text may cross the shared session model; stderr is discarded.
    console.error('native log: '+key);
    send({method:'session/update',params:{sessionId:'fixture-native', update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
    result = {stopReason:'end_turn'};
  } else return;
  send({id:request.id,result});
});`, { mode: 0o700 });
  return { root, lock, env, connect: (signal: AbortSignal, key: unknown = isolatedKey, verify = verified) => openAgyProfile(root, signal, { key, env, verify }) };
}

describe("Antigravity ACP process", () => {
  it("cancels permission requests without granting access", async () => {
    const client = await connectAgy({ cli: fixture(true) });
    try { expect(await client.request("session/prompt", {})).toEqual({ outcome: { outcome: "cancelled" } }); }
    finally { await client.stop(); }
  });

  it("rejects a process below the minimum, without native load support or developer authentication", async () => {
    await expect(connectAgy({ cli: fixture(false) })).rejects.toThrow("ACP v1");
    await expect(connectAgy({ cli: fixture(true, "1.5.16") })).rejects.toThrow(AGY_VERSION);
    await expect(connectAgy({ cli: fixture(true, AGY_VERSION, "oauth-personal") })).rejects.toThrow("所选认证方式");
  });

  it("accepts a newer CLI with the required ACP capabilities", async () => {
    const client = await connectAgy({ cli: fixture(true, "1.6.0") });
    await client.stop();
  });

  // AGY-15: not even the profile lock is taken if proof of the developer key
  // is missing, rejected, or revoked while the independent HTTP check is in flight.
  it.skipIf(process.platform === "win32")("fails closed before launching with missing, rejected or revoked credentials", async () => {
    const { root, lock, connect } = await nativeFixture();
    const abort = new AbortController();
    try {
      await expect(connect(abort.signal, null)).rejects.toThrow("API Key");
      await expect(connect(abort.signal, isolatedKey, async () => "rejected")).rejects.toThrow("Google 未接受");
      const check = connect(abort.signal, isolatedKey, async () => { abort.abort(); return "verified"; });
      await expect(check).rejects.toMatchObject({ name: "AbortError" });
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("requires both Google verification and a native ACP session-list handshake before replacement", async () => {
    const { root, lock, env } = await nativeFixture();
    try {
      const verifiedCalls = vi.fn(async () => "verified" as const);
      expect(await verifyAgyConnection(isolatedKey, { env, cli: { command: env.ORBIS_AGY_ENTRY, prefixArgs: [] }, verify: verifiedCalls })).toBe("verified");
      expect(verifiedCalls).toHaveBeenCalledOnce();
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await verifyAgyConnection(isolatedKey, { env, cli: { command: env.ORBIS_AGY_ENTRY, prefixArgs: [] }, verify: async () => "rejected" })).toBe("rejected");
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  // AGY-11/15: connect → authenticate → readiness → create → streamed first
  // prompt, then retry with a replacement on the same isolated native profile.
  it.skipIf(process.platform === "win32")("uses a single isolated process and redacts the credential from a streamed first answer", async () => {
    const { root, lock, connect } = await nativeFixture();
    const signal = new AbortController().signal;
    try {
      for (const [key, text] of [[isolatedKey, "original"], [replacementKey, "rotated"]] as const) {
        const runtime = new AgyRuntime(s => connect(s, key));
        const events: RuntimeEvent[] = [];
        runtime.setEventSink(event => events.push(event));
        try {
          await runtime.start();
          expect(runtime.isReady()).toBe(true);
          await expect(stat(lock)).resolves.toBeDefined();
          await expect(connect(signal)).rejects.toThrow("专用目录已被占用");
          const result = await runtime.activate({ type: "new", cwd: root });
          expect(result).toEqual({ sessionId: "agy:fixture-native", spawnMode: "headless" });
          runtime.dispatchCommand("agy:fixture-native", "first-send", { type: "user_message", text: "fixture question", messageId: "fixture-first" });
          await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ commandId: "first-send", status: "success" })));
          const observed = JSON.stringify(events);
          expect(observed).toContain(`${text} answer [REDACTED]`);
          expect(observed).not.toContain(key);
        } finally { await runtime.stop(); }
        await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
