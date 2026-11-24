import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KimiSessions, KIMI_DESKTOP_KIND, KIMI_KIND, kimiKindFromId, kimiSourceKey } from "./kimi-sessions.js";
import { SessionConfigurationStore } from "./session-configuration-store.js";

const id = "session_native_first", other = "session_native_second", workspace = "workspace_a";
const date = "2026-11-19T00:15:00.000Z";
let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "orbis-kimi-sessions-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const row = (session: string, marker?: string, archived = false) => ({ id: session, workspace_id: workspace, title: "Same name",
  created_at: date, updated_at: date, busy: false, main_turn_active: false, archived, agent_config: { model: "model" },
  metadata: { cwd: root, ...(marker ? { orbis_launch_marker: marker } : {}) } });
const item = (id: string) => ({ id, workspace: { cwd: root }, meta: { title: "Same name", created_at: 1, updated_at: 2, archived: false } });
function fixture(handler: (path: string, init?: { method?: string; body?: unknown }) => unknown) {
  const request = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => handler(path, init));
  return { request, sessions: new KimiSessions({ requestJson: <T>(path: string, init?: { method?: string; body?: unknown }) => request(path, init) as Promise<T> }, "test-root") };
}

describe("KIMI-02 native session identity", () => {
  // HOST-RUNNING-01: unrelated native work and archived rows are not running chats.
  it("reads main-turn presence without subscribing or using the history catalog", async () => {
    const { sessions, request } = fixture(() => ({ has_more: false, items: [
      { ...row(id), busy: false, main_turn_active: true }, { ...row(other), busy: true },
      { ...row("session_archived", undefined, true), main_turn_active: true },
    ] }));
    await expect(sessions.runningSessions()).resolves.toEqual([{ sessionId: sessions.publicId(id), name: "Same name" }]);
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^\/api\/v1\/sessions\?/u), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps names independent of identity and propagates an opaque cursor without interpreting it", async () => {
    const { sessions, request } = fixture(path => new URL(path, "http://localhost").searchParams.has("page_token")
      ? { items: [{ ...item(other), meta: { ...item(other).meta, title: null } }], has_more: false, next_page_token: null }
      : { items: [item(id)], has_more: true, next_page_token: "opaque/+?=" });
    const result = await sessions.catalog(false);
    expect(result.complete).toBe(true);
    expect(result.sessions.map(value => value.sessionId)).toEqual([sessions.publicId(id), sessions.publicId(other)]);
    expect(result.sessions[1]?.name).toBeUndefined();
    expect(request.mock.calls[1]?.[0]).toContain("page_token=opaque%2F%2B%3F%3D");
    expect(await kimiSourceKey(root)).toEqual(await kimiSourceKey(root));
    expect(sessions.nativeId(sessions.publicId(id))).toBe(id);
    expect(() => sessions.nativeId(new KimiSessions({ requestJson: async () => { throw new Error(); } }, "another-root").publicId(id))).toThrow();
  });

  it("keeps Web and Desktop session namespaces disjoint and recognizes pre-split Desktop IDs", () => {
    const client = { requestJson: async <T>() => ({} as T) };
    const web = new KimiSessions(client, "same-root", KIMI_KIND);
    const desktop = new KimiSessions(client, "same-root", KIMI_DESKTOP_KIND);
    const webId = web.publicId(id), desktopId = desktop.publicId(id);
    expect(webId).not.toBe(desktopId);
    expect(kimiKindFromId(webId)).toBe(KIMI_KIND);
    expect(kimiKindFromId(desktopId)).toBe(KIMI_DESKTOP_KIND);
    expect(kimiKindFromId("kimi-code:desktop-old-root:session_native_first")).toBe(KIMI_DESKTOP_KIND);
    expect(web.nativeId(webId)).toBe(id);
    expect(desktop.nativeId(desktopId)).toBe(id);
    expect(() => web.nativeId(desktopId)).toThrow("不属于当前 Kimi Code 数据源");
    expect(() => desktop.nativeId(webId)).toThrow("不属于当前 Kimi Code 数据源");
  });

  it("preserves a valid first page when a later page fails or loops", async () => {
    const { sessions } = fixture(path => {
      if (path.includes("page_token=")) throw new Error("fixture timeout");
      return { items: [item(id)], has_more: true, next_page_token: "token" };
    });
    expect(await sessions.catalog(false)).toMatchObject({ complete: false, sessions: [{ sessionId: sessions.publicId(id) }] });
  });

  it("reserves an opaque launch marker before a native side effect and recovers only one exact match", async () => {
    const ledgerPath = join(root, "launch.json");
    const ledger = new SessionConfigurationStore(ledgerPath);
    const request = { type: "session.launch" as const, agentKind: "kimiCode" as const, requestId: "r", launchId: "first", cwd: root,
      binding: "kimi-code:test-root:local", revision: 0, values: {}, spawnMode: "headless" as const };
    const first = await ledger.begin("phone", request);
    const marker = first.record.nativeLaunchMarker!;
    const next = new SessionConfigurationStore(ledgerPath);
    expect(await next.result("phone", "first", "read")).toMatchObject({ phase: "unknown" });
    expect(await next.launchMarker("phone", "first")).toEqual({ marker, cwd: root, binding: request.binding });
    expect((await next.begin("phone", request)).execute).toBe(false);
    let duplicate = false;
    const { sessions, request: native } = fixture(path => {
      if (path.endsWith("/environment")) return { workspace_id: workspace, environment_id: "local", cwd: root };
      if (!path.includes("?")) return row(id, marker);
      return { items: [row(id, marker), row(other, duplicate ? marker : undefined)], has_more: false };
    });
    expect(await sessions.findLaunch(marker, root)).toBe(sessions.publicId(id));
    duplicate = true;
    expect(await sessions.findLaunch(marker, root)).toBeUndefined();
    expect(native.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("requires native model readiness and local execution; archives and restores only the exact session", async () => {
    let archived = false, local = true, ready = false;
    const { sessions, request } = fixture((path, init) => {
      if (path === "/api/v1/auth") return { models_ready: ready };
      if (path.endsWith("/environment")) return { workspace_id: workspace, environment_id: local ? "local" : "remote", cwd: root };
      if (path.endsWith(":archive") || path.endsWith(":restore")) { archived = path.endsWith(":archive"); return {}; }
      if (init?.method === "POST") return row(id, "marker");
      return row(id, undefined, archived);
    });
    await expect(sessions.create(root, "marker")).rejects.toMatchObject({ code: "agent_unsupported" });
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    ready = true;
    await sessions.create(root, "marker");
    expect(request).toHaveBeenCalledWith("/api/v1/sessions", expect.objectContaining({ body: {
      metadata: { cwd: root, orbis_launch_marker: "marker" }, environment_id: "local",
    } }));
    await sessions.setArchived(sessions.publicId(id), true);
    expect(archived).toBe(true);
    await sessions.setArchived(sessions.publicId(id), false);
    expect(archived).toBe(false);
    local = false;
    await expect(sessions.setArchived(sessions.publicId(id), true)).rejects.toMatchObject({ code: "agent_unsupported" });
    expect(archived).toBe(false);
  });
});
