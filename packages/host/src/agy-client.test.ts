import { mkdtemp, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGY_VERSION, connectAgy, openAgyProfile } from "./agy-client.js";

// Exercise the actual subprocess boundary, including agent-initiated permission requests.
const fixture = (compatible: boolean, version = AGY_VERSION) => ({ command: process.execPath, prefixArgs: ["-e", `
  const rl = require('node:readline').createInterface({input:process.stdin});
  const send = frame => console.log(JSON.stringify({jsonrpc:'2.0',...frame}));
  let pending;
  rl.on('line', line => {
    const row = JSON.parse(line);
    if (row.method === 'initialize') send({id:row.id,result:{protocolVersion:1,
      agentInfo:{version:${JSON.stringify(version)}}, agentCapabilities:{loadSession:${compatible}, sessionCapabilities:{list:{}}}}});
    if (row.method === 'session/prompt') { pending = row.id; send({id:'permission',method:'session/request_permission',params:{}}); }
    if (row.id === 'permission') send({id:pending,result:row.result});
  });`, "--"] });

describe("Antigravity ACP process", () => {
  it("cancels permission requests without granting access", async () => {
    const client = await connectAgy({ cli: fixture(true) });
    try { expect(await client.request("session/prompt", {})).toEqual({ outcome: { outcome: "cancelled" } }); }
    finally { await client.stop(); }
  });
  it("rejects a process without native load support", async () => {
    await expect(connectAgy({ cli: fixture(false) })).rejects.toThrow("ACP v1");
    await expect(connectAgy({ cli: fixture(true, "1.5.16") })).rejects.toThrow(AGY_VERSION);
  });
});

// AGY-11: configured authentication must be the native API-key method, not the
// existing user profile, inherited Relay credentials, or unnegotiated ACP tools.
it.skipIf(process.platform === "win32")("owns and releases one isolated profile, with no ambient credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbis-agy-profile-"));
  const bin = join(root, "agy-fixture");
  const lock = join(root, "agy-acp", "owner.lock");
  const env = { ORBIS_AGY_ENTRY: bin, ORBIS_AGY_ENABLED: "1", GEMINI_API_KEY: "fixture-only-not-a-key", ORBIS_RUNTIME_CREDENTIAL: "must-not-inherit", HOME: root };
  await writeFile(bin, `#!${process.execPath}
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    if (process.env.ORBIS_RUNTIME_CREDENTIAL || !process.env.HOME.endsWith('/agy-acp/home') || !process.argv.includes('--sandbox') || process.argv.includes('--dangerously-skip-permissions')) process.exit(19);
    result = {protocolVersion:1,agentInfo:{version:'${AGY_VERSION}'},agentCapabilities:{loadSession:true,sessionCapabilities:{list:{},close:{}}}};
  } else if (request.method === 'authenticate') {
    if (request.params.methodId !== 'gemini-api-key' || process.env.GEMINI_API_KEY !== 'fixture-only-not-a-key') process.exit(20);
    result = {};
  } else return;
  console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});`, { mode: 0o700 });
  const signal = new AbortController().signal;
  try {
    await expect(openAgyProfile(root, signal, { ...env, ORBIS_AGY_ENABLED: "0" })).rejects.toThrow("Host");
    await expect(openAgyProfile(root, signal, { ...env, GEMINI_API_KEY: "" })).rejects.toThrow("API key");
    const first = await openAgyProfile(root, signal, env);
    try {
      expect(first.supportsClose).toBe(true);
      await expect(stat(lock)).resolves.toBeDefined();
      await expect(openAgyProfile(root, signal, env)).rejects.toThrow("Antigravity CLI");
    } finally { await first.stop(); }
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    await (await openAgyProfile(root, signal, env)).stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});
