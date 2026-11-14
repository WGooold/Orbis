import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@orbis/protocol";
import { HostService } from "../../host/src/host-service.js";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { createRelayServer, type RelayServer } from "./index.js";
import { qaRelayOptions, readQaActivation } from "./qa-config.js";

const fixture = { version: 1, environmentId: "isolated-auth-fixture", relayUrl: "wss://qa.example.test:18443", credential: "qa-private-fixture-credential-12345" };

describe("QA-ACT-01 package Relay activation", () => {
  let relay: RelayServer | undefined;
  let host: HostService | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await host?.stop(); await relay?.close(); host = undefined; relay = undefined; });

  async function setup() {
    const root = await testDirectory(join(tmpdir(), "orbis-qa-activation-"));
    await writeFile(join(root, "qa-activation.json"), JSON.stringify(fixture), { mode: 0o600 });
    const options = await qaRelayOptions(["--qa-package", "--qa-data-dir", join(root, "data")], {
      PORT: "0", HOST: "0.0.0.0", ORBIS_ADMIN_TOKEN: "formal-admin", ORBIS_RUNTIME_CREDENTIAL: "formal-runtime",
      ORBIS_STATE_FILE: "/formal/state.json", ORBIS_REGISTRATION_STATE_FILE: "/formal/registration.json",
    }, root);
    return { root, options: options! };
  }

  async function authenticate(credential: string, id: string): Promise<Record<string, unknown>> {
    const socket = new WebSocket(`${relay!.url}/v1/runtime`); sockets.push(socket);
    await once(socket, "open");
    const response = once(socket, "message");
    socket.send(JSON.stringify({ type: "runtime.authenticate", protocolVersion: PROTOCOL_VERSION, credential, role: "host", runtime: { runtimeId: id, name: "QA fixture", cwd: "/fixture", status: "idle" } }));
    return JSON.parse(String((await response)[0])) as Record<string, unknown>;
  }

  it("uses private state and activation while ignoring production Relay configuration", async () => {
    const { root, options } = await setup();
    expect(options).toMatchObject({ host: "127.0.0.1", port: 0, stateFile: join(root, "data/relay-state.json"), runtimeCredentials: [fixture.credential] });
    expect(options.adminToken).toBeUndefined(); expect(options.registration).toBeUndefined(); expect(options.apns).toBeUndefined();
    expect(await qaRelayOptions([], { ORBIS_RUNTIME_CREDENTIAL: "formal" }, root)).toBeUndefined();
    await expect(qaRelayOptions(["--qa-package"], { ORBIS_QA_ADMIN_TOKEN: fixture.credential }, root)).rejects.toThrow("must differ");
  });

  it("connects the real HostService and pairs without granting its credential administrator access", async () => {
    const { root, options } = await setup(); relay = await createRelayServer(options);
    await mkdir(join(root, "sessions"));
    host = await HostService.create({ relayUrl: relay.url, credential: fixture.credential, stateDir: join(root, "host"), sessionsRoot: join(root, "sessions"), loopback: false, lan: false });
    await host.start();
    expect(host.relayState).toBe("connected");
    const opened = await host.openPairingWindow();
    expect(opened.payload).toHaveProperty("code");
    const base = relay.url.replace("ws://", "http://");
    expect((await fetch(`${base}/v1/devices`, { headers: { authorization: `Bearer ${fixture.credential}` } })).status).toBe(401);
    await expect(authenticate("wrong-qa-credential", "wrong-host")).resolves.toMatchObject({ type: "protocol.error", code: "unauthorized" });
    expect(await readFile(join(root, "qa-activation.json"), "utf8")).toContain(fixture.credential);
  });

  it("does not let a shared token choose arbitrarily between two connected QA Hosts", async () => {
    const { options } = await setup(); relay = await createRelayServer(options);
    await authenticate(fixture.credential, "qa-one"); await authenticate(fixture.credential, "qa-two");
    const response = await fetch(`${relay.url.replace("ws://", "http://")}/v1/pairing-codes`, { method: "POST", headers: { authorization: `Bearer ${fixture.credential}` } });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "qa_host_ambiguous" });
  });

  it("leaves ordinary runtime credentials unable to authorize pairing", async () => {
    relay = await createRelayServer({ port: 0, runtimeCredentials: [fixture.credential] });
    await authenticate(fixture.credential, "ordinary-host");
    expect((await fetch(`${relay.url.replace("ws://", "http://")}/v1/pairing-codes`, { method: "POST", headers: { authorization: `Bearer ${fixture.credential}` } })).status).toBe(401);
  });

  it("fails closed on missing or malformed private manifests without echoing their contents", async () => {
    const root = await testDirectory(join(tmpdir(), "orbis-qa-invalid-"));
    await expect(qaRelayOptions(["--qa-package"], {}, root)).rejects.toThrow("Cannot read QA activation file");
    const path = join(root, "broken.json"); await writeFile(path, `{"credential":"${fixture.credential}`);
    await expect(readQaActivation(path)).rejects.toThrow(/^Invalid QA activation JSON$/);
    await writeFile(path, JSON.stringify({ ...fixture, relayUrl: "https://qa.example.test" }));
    await expect(readQaActivation(path)).rejects.toThrow("must use WSS");
  });
});
