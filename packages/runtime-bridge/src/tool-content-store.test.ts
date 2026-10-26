import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_PAGE_MAX_BYTES, ToolContentPageSchema, toolJsonBytes, type ToolContentLocator,
  type ToolContentReadRequest } from "@orbis/protocol";
import { ToolContentStore, createProcessToolContentStore } from "./tool-content-store.js";

const directories: string[] = [];
const stores: ToolContentStore[] = [];
const locator = (toolCallId = "call"): ToolContentLocator => ({ projectionVersion: 1,
  tool: { agent: { hostId: "host", agentKind: "codex", sessionId: "session" }, toolCallId }, part: "output" });
let requestSequence = 0;
const request = (which = locator()): ToolContentReadRequest => ({ type: "session.tool.content.read",
  requestId: `request-${++requestSequence}`, runtimeId: "runtime", viewerId: "viewer", locator: which, read: null, offset: 0, maxBytes: 16_384 });
async function make(options: Omit<Parameters<typeof ToolContentStore.create>[0], "directory" | "producerId"> = {}): Promise<ToolContentStore> {
  const directory = await mkdtemp(join(tmpdir(), "orbis-tool-content-test-"));
  directories.push(directory);
  const store = await ToolContentStore.create({ directory, producerId: "test-producer", ...options });
  stores.push(store); return store;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("producer tool content store (ADR-0045)", () => {
  it("reclaims only an OS-confirmed dead producer lock and preserves unrelated producers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-stale-tool-store-")); directories.push(directory);
    const hash = createHash("sha256").update("dead").digest("hex");
    await writeFile(join(directory, `tool-content-${hash}.lock`), JSON.stringify({ pid: 123456 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(pid => { if (pid === process.pid) return true; throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    const other = await ToolContentStore.create({ directory, producerId: "other" }); stores.push(other);
    const retained = await other.begin(locator(), "text"); await other.append(locator(), retained.contentEpoch, "other producer");
    const recovered = await createProcessToolContentStore(directory, "dead"); stores.push(recovered);
    expect(kill).toHaveBeenCalledWith(123456, 0);
    expect((await other.read("owner", request())).text).toBe("other producer");
    await expect(createProcessToolContentStore(directory, "dead")).rejects.toMatchObject({ code: "EEXIST" });
    kill.mockRestore();
  });
  it("retains 10 MiB without shared-state payloads and reads only bounded pages", async () => {
    const store = await make();
    const part = await store.begin(locator(), "text");
    for (let index = 0; index < 10; index++) await store.append(locator(), part.contentEpoch, "x".repeat(1024 * 1024));
    const done = await store.finish(locator(), part.contentEpoch);
    expect(done.availableThroughOffset).toBe(10 * 1024 * 1024);
    expect(done.gaps).toEqual([]);
    const page = await store.read("device:viewer", request());
    expect(page.text).toHaveLength(16_384);
    expect(page.read.throughOffset).toBe(done.availableThroughOffset);
    expect(page.contentFinal).toBe(true);
    expect(toolJsonBytes(page)).toBeLessThan(TOOL_PAGE_MAX_BYTES);
    expect(ToolContentPageSchema.safeParse(page).success).toBe(true);
    expect(store.usage.retainedBytes).toBe(10 * 1024 * 1024);
  });

  it("pins an existing read through append and starts a later read at new content", async () => {
    const store = await make(); const part = await store.begin(locator(), "text");
    await store.append(locator(), part.contentEpoch, "abcdefgh");
    const initial = { ...request(), maxBytes: 4 };
    const first = await store.read("owner", initial);
    await store.append(locator(), part.contentEpoch, "ijkl");
    expect((await store.read("owner", initial)).read).toEqual(first.read);
    await expect(store.read("owner", { ...initial, offset: 1 })).rejects.toMatchObject({ reason: "scope_mismatch" });
    const retry = await store.read("owner", { ...request(), read: first.read, maxBytes: 4 });
    expect(retry.text).toBe(first.text);
    expect(retry.read).toEqual(first.read);
    const tail = await store.read("owner", { ...request(), read: first.read, offset: first.nextCursor!, maxBytes: 4 });
    expect(tail.text).toBe("efgh"); expect(tail.nextCursor).toBeNull(); expect(tail.contentFinal).toBe(false);
    const follow = await store.read("owner", { ...request(), offset: 8 });
    expect(follow.text).toBe("ijkl"); expect(follow.read.throughOffset).toBe(12);
  });

  it("invalidates replacement, checks owner and session, and cancels only the requested read", async () => {
    const store = await make(); const part = await store.begin(locator(), "text");
    await store.append(locator(), part.contentEpoch, "original");
    const old = await store.read("a", request());
    await expect(store.read("b", { ...request(), read: old.read })).rejects.toMatchObject({ reason: "scope_mismatch" });
    await expect(store.cancel("b", old.read.readId)).rejects.toMatchObject({ reason: "scope_mismatch" });
    const other = await store.begin(locator("other"), "text");
    await expect(store.read("a", { ...request(locator("other")), read: { ...old.read, contentEpoch: other.contentEpoch } }))
      .rejects.toMatchObject({ reason: "scope_mismatch" });
    const replacement = await store.begin(locator(), "json");
    expect(replacement.contentEpoch).not.toBe(old.read.contentEpoch);
    await expect(store.read("a", { ...request(), read: old.read })).rejects.toMatchObject({ reason: "content_version_invalid" });
    await expect(store.append(locator(), part.contentEpoch, "late")).rejects.toMatchObject({ reason: "content_version_invalid" });
    const current = await store.read("a", request());
    await store.cancel("a", current.read.readId);
    await expect(store.read("a", { ...request(), read: current.read })).rejects.toMatchObject({ reason: "content_expired" });
    expect(store.usage.parts).toBe(2);
  });

  it("retains UTF-8 prefixes at quotas and reports the exact missing suffix", async () => {
    const store = await make({ limits: { perPartBytes: 7, producerBytes: 16 } });
    const part = await store.begin(locator(), "text");
    const first = await store.append(locator(), part.contentEpoch, "ab😀中");
    expect(first.availableThroughOffset).toBe(6);
    expect(first.gaps).toEqual([{ fromOffset: 6, throughOffset: 9, reason: "quota" }]);
    await store.append(locator(), part.contentEpoch, "tail");
    const page = await store.read("owner", request());
    expect(page.text).toBe("ab😀"); expect(page.read.throughOffset).toBe(6);
    expect(page.observedThroughOffset).toBe(13);
    expect(page.gaps).toEqual([{ fromOffset: 6, throughOffset: 13, reason: "quota" }]);
    await expect(store.read("owner", { ...request(), offset: 7 })).rejects.toMatchObject({ reason: "content_range_unavailable" });
  });

  it("evicts oldest parts for total quota and invalidates their leases explicitly", async () => {
    const store = await make({ limits: { perPartBytes: 8, producerBytes: 12 } });
    const a = await store.begin(locator(), "text"); await store.append(locator(), a.contentEpoch, "12345678");
    const read = await store.read("owner", request());
    const b = await store.begin(locator("b"), "text"); await store.append(locator("b"), b.contentEpoch, "ABCDEFGH");
    expect(store.usage.retainedBytes).toBe(8);
    await expect(store.read("owner", { ...request(), read: read.read })).rejects.toMatchObject({ reason: "content_expired" });
    expect((await store.read("owner", request(locator("b")))).text).toBe("ABCDEFGH");
  });

  it("records known missing source bytes without joining later output across the gap", async () => {
    const store = await make(); const part = await store.begin(locator(), "text");
    await store.append(locator(), part.contentEpoch, "prefix");
    await store.recordGap(locator(), part.contentEpoch, 10, "source-missing");
    await store.append(locator(), part.contentEpoch, "tail");
    const page = await store.read("owner", request());
    expect(page.text).toBe("prefix");
    expect(page.gaps).toEqual([{ fromOffset: 6, throughOffset: 20, reason: "source-missing" }]);
    expect(page.observedThroughOffset).toBe(20);
  });

  it("applies a shared per-tool budget across content parts and frees replaced read leases", async () => {
    const store = await make({ limits: { perPartBytes: 8, perToolBytes: 10, maxReads: 1 } });
    const output = await store.begin(locator(), "text");
    await store.append(locator(), output.contentEpoch, "12345678");
    const argsLocator = { ...locator(), part: "arguments" as const };
    const args = await store.begin(argsLocator, "json");
    expect((await store.append(argsLocator, args.contentEpoch, "{}more")).availableThroughOffset).toBe(2);
    const old = await store.read("owner", request());
    const replaced = await store.begin(locator(), "text");
    expect(store.usage.reads).toBe(0);
    expect((await store.read("owner", request())).read.contentEpoch).toBe(replaced.contentEpoch);
    await expect(store.read("owner", { ...request(), read: old.read })).rejects.toMatchObject({ reason: "content_version_invalid" });
  });

  it("expires leases independently of content, and content independently of reads", async () => {
    let now = 0; const store = await make({ clock: () => now, limits: { readLeaseMs: 100, retentionMs: 1000 } });
    const part = await store.begin(locator(), "text"); await store.append(locator(), part.contentEpoch, "text");
    const read = await store.read("owner", request());
    now = 101;
    await expect(store.read("owner", { ...request(), read: read.read })).rejects.toMatchObject({ reason: "content_expired" });
    expect((await store.read("owner", request())).text).toBe("text");
    now = 1000; await store.sweep();
    expect(store.usage).toMatchObject({ parts: 0, reads: 0, retainedBytes: 0 });
    await expect(store.read("owner", request())).rejects.toMatchObject({ reason: "content_expired" });
  });

  it("sweeps idle content without requiring another producer or viewer operation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 0; const store = await make({ clock: () => now, limits: { retentionMs: 100, readLeaseMs: 50 } });
    const part = await store.begin(locator(), "text");
    await store.append(locator(), part.contentEpoch, "idle output");
    now = 101; await vi.advanceTimersByTimeAsync(50);
    // begin is ordered after the timer sweep; it does not itself expire the existing read state.
    await store.cancel("owner", "unknown-read");
    expect(store.usage).toMatchObject({ retainedBytes: 0, parts: 0, maintenanceFailures: 0 });
  });

  it("pages JSON as text with full escaped-response budget and rejects mid-codepoint offsets", async () => {
    const store = await make(); const part = await store.begin(locator(), "json");
    const text = "😀" + "\u0000".repeat(40_000);
    await store.append(locator(), part.contentEpoch, text);
    const first = await store.read("owner", { ...request(), maxBytes: 60 * 1024 });
    expect(toolJsonBytes(first)).toBeLessThanOrEqual(60 * 1024);
    expect(first.representation).toBe("utf8-fragment"); expect(first.format).toBe("json");
    expect(first.text.length).toBeLessThan(40_000);
    await expect(store.read("owner", { ...request(), offset: 1 })).rejects.toMatchObject({ reason: "invalid_utf8_offset" });
    let accumulated = first.text; let offset = first.nextCursor;
    while (offset !== null) {
      const next = await store.read("owner", { ...request(), read: first.read, offset, maxBytes: 60 * 1024 });
      accumulated += next.text; offset = next.nextCursor;
    }
    expect(accumulated).toBe(text);
  });

  it("bounds pending writes and read identities, and honors abort without cancelling the tool", async () => {
    const store = await make({ limits: { maxPendingOperations: 1, maxReads: 1 } });
    const part = await store.begin(locator(), "text");
    const pending = store.append(locator(), part.contentEpoch, "content");
    await expect(store.append(locator(), part.contentEpoch, "not accepted")).rejects.toMatchObject({ reason: "busy" });
    await pending;
    const controller = new AbortController(); controller.abort();
    await expect(store.read("owner", request(), controller.signal)).rejects.toMatchObject({ reason: "cancelled" });
    const read = await store.read("owner", request());
    await expect(store.read("owner", request())).rejects.toMatchObject({ reason: "busy" });
    await store.cancel("owner", read.read.readId);
    expect((await store.finish(locator(), part.contentEpoch)).contentFinal).toBe(true);
    expect((await store.read("owner", request())).text).toBe("content");
  });

  it("rejects invalid Unicode and bounds request records without changing an existing read", async () => {
    const store = await make({ limits: { maxRequests: 1 } });
    const part = await store.begin(locator(), "text");
    await expect(store.append(locator(), part.contentEpoch, String.fromCharCode(0xd800)))
      .rejects.toThrow("invalid_tool_content_unicode");
    await store.append(locator(), part.contentEpoch, "valid");
    const initial = request();
    const first = await store.read("owner", initial);
    await expect(store.read("owner", request())).rejects.toMatchObject({ reason: "busy" });
    expect((await store.read("owner", initial)).read).toEqual(first.read);
    expect((await store.read("owner", { ...request(), read: first.read })).text).toBe("valid");
  });

  it("does not reuse temporary content after restart and cleans owned files on dispose", async () => {
    const store = await make(); const part = await store.begin(locator(), "text");
    await store.append(locator(), part.contentEpoch, "private output");
    const other = await ToolContentStore.create({ directory: directories[0]!, producerId: "other-producer" }); stores.push(other);
    await expect(other.read("owner", request())).rejects.toMatchObject({ reason: "content_unavailable" });
    await store.dispose(); await other.dispose();
    expect(await readdir(directories[0]!)).toEqual([]);
  });

  it("locks each producer and cleans stale owned files when ownership is explicitly reclaimed", async () => {
    const store = await make(); const directory = directories[0]!;
    await expect(ToolContentStore.create({ directory, producerId: "test-producer" })).rejects.toMatchObject({ code: "EEXIST" });
    const root = (await readdir(directory)).find(value => !value.endsWith(".lock"))!;
    await store.dispose();
    await mkdir(join(directory, root));
    await writeFile(join(directory, root, "old-content"), "stale output");
    const lock = join(directory, root + ".lock");
    await writeFile(lock, "stale");
    const restarted = await ToolContentStore.create({ directory, producerId: "test-producer", reclaimStale: true });
    stores.push(restarted);
    expect(await readdir(join(directory, root))).toEqual([]);
    await expect(restarted.read("owner", request())).rejects.toMatchObject({ reason: "content_unavailable" });
    await restarted.dispose(); expect(await readdir(directory)).toEqual([]);
  });
});
