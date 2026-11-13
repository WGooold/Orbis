import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeviceStore, loadOrCreateHostIdentity, saveDeviceStore, toBase64Url } from "@orbis/e2e";
import { createRelayServer, type RelayServer } from "../../relay/src/index.js";
import { RegistrationAuthority } from "../../relay/src/registration.js";
import { DesktopRuntime, type DesktopEvent } from "./desktop-runtime.js";
import * as claudeVersion from "./claude-version.js";
import { DshRuntime } from "./dsh-runtime.js";

// HOST-ACT-15/16: a computer that lost its Relay credential must always be able to work again —
// with its own key when the Relay recorded it, otherwise as a new computer. These drive the actual
// Relay registration routes with the actual Host identity files.
describe("desktop Host credential recovery", () => {
  let root = "";
  let relay: RelayServer | undefined;
  let runtime: DesktopRuntime | undefined;
  beforeEach(async () => {
    vi.spyOn(DshRuntime, "connectExisting").mockResolvedValue(undefined);
    vi.spyOn(claudeVersion, "readClaudeVersion").mockResolvedValue("2.1.322");
    root = await mkdtemp(join(tmpdir(), "orbis-desktop-identity-"));
  });
  afterEach(async () => {
    await runtime?.close(); runtime = undefined;
    await relay?.close(); relay = undefined;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  // The deployed policy: new computers may activate without a mailbox.
  const directRelay = async (): Promise<RelayServer> => {
    const adminStateFile = join(root, "relay-admin.json");
    await writeFile(adminStateFile, JSON.stringify({ version: 1, disabledHosts: [], events: [], qqEmailVerificationRequired: false }));
    return await createRelayServer({ adminStateFile, registration: await RegistrationAuthority.create({}) });
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${relay!.url.replace("ws:", "http:")}${path}`, { method: "POST", body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it("proves its recorded key to replace a lost credential and connects with the replacement", async () => {
    relay = await directRelay();
    const events: DesktopEvent[] = [];
    const state = join(root, "state");
    runtime = new DesktopRuntime(event => events.push(event), state, { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const identity = await loadOrCreateHostIdentity({ dir: state });
    const hostId = identity.hostId;
    const activated = await post("/v1/registration/activate", { hostId, hostPub: toBase64Url(identity.publicRaw) });
    expect(activated.status).toBe(201);
    const challenge = await post("/v1/registration/recovery-challenge", { hostId });
    expect(challenge.status).toBe(201);
    await expect(runtime.hostRecoveryProof({ hostId: "another-host", challengeId: String(challenge.body.challengeId), relayPub: String(challenge.body.relayPub) }))
      .rejects.toThrow("电脑身份已变化");
    const { proof } = await runtime.hostRecoveryProof({ hostId, challengeId: String(challenge.body.challengeId), relayPub: String(challenge.body.relayPub) });
    const recovered = await post("/v1/registration/recover", { hostId, challengeId: challenge.body.challengeId, proof });
    expect(recovered.status).toBe(201);
    expect(recovered.body.credential).not.toBe(activated.body.credential);
    await runtime.start({ relayUrl: relay.url, credential: String(recovered.body.credential), lanPort: 0, codexEnabled: false, dshEnabled: false });
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ event: "state", state: "connected" })));
    await expect(runtime.replaceIdentity()).rejects.toThrow("请先暂停连接");
    await runtime.stop();
  });

  it("activates as a new computer when its Host ID cannot be restored, keeping the old identity and pairings", async () => {
    relay = await directRelay();
    const state = join(root, "state");
    runtime = new DesktopRuntime(() => {}, state, { pi: join(root, "pi"), codex: join(root, "codex"), dsh: join(root, "dsh") });
    const previous = await loadOrCreateHostIdentity({ dir: state, hostName: "workstation" });
    const store = await loadDeviceStore(state);
    store.devices.push({ deviceId: "phone-one", devicePub: "pub", pskRoot: "psk", label: "phone", createdAt: 1, revoked: false });
    await saveDeviceStore(state, store);
    const previousIdentityFile = await readFile(join(state, "host.json"), "utf8");
    // A released desktop registered this Host without a key, then lost its credential.
    expect((await post("/v1/registration/activate", { hostId: previous.hostId })).status).toBe(201);
    expect((await post("/v1/registration/activate", { hostId: previous.hostId })).body.error).toBe("host_already_registered");
    expect((await post("/v1/registration/recovery-challenge", { hostId: previous.hostId })).status).toBe(404);
    const replaced = await runtime.replaceIdentity() as { hostId: string; hostName: string; hostPub: string; devices: unknown[] };
    expect(replaced.hostId).not.toBe(previous.hostId);
    expect(replaced).toMatchObject({ hostName: "workstation", devices: [] });
    expect((await loadOrCreateHostIdentity({ dir: state })).hostId).toBe(replaced.hostId);
    expect((await loadDeviceStore(state)).devices).toEqual([]);
    const [archived] = await readdir(join(state, "retired-identities"));
    expect(archived).toMatch(new RegExp(`^${previous.hostId}-\\d+$`));
    expect(await readFile(join(state, "retired-identities", archived!, "host.json"), "utf8")).toBe(previousIdentityFile);
    expect((await loadDeviceStore(join(state, "retired-identities", archived!))).devices).toHaveLength(1);
    const activated = await post("/v1/registration/activate", { hostId: replaced.hostId, hostPub: replaced.hostPub });
    expect(activated.status).toBe(201);
    expect((await post("/v1/registration/recovery-challenge", { hostId: replaced.hostId })).status).toBe(201);
  });
});
