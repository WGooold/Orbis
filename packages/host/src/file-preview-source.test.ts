import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { FILE_PREVIEW_CHUNK_BYTES, NATIVE_FILE_PREVIEW_BYTES, RelayToDeviceMessageSchema, RuntimeCommandSchema, WEB_PREVIEW_ENTRY_BYTES,
  decodeArtifactChunkFrame, type RelayToDeviceMessage, type RuntimeEvent } from "@orbis/protocol";
import { HostDownloadService } from "./artifact-download.js";
import { MessageFileReferences } from "./message-file-references.js";
import { locateWebPreview, readWebPreview } from "./file-preview-source.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = async () => {
  const dir = await testDirectory(join(tmpdir(), "orbis-web-preview-"));
  const refs = new MessageFileReferences();
  const events: RuntimeEvent[] = [];
  const replies: RelayToDeviceMessage[] = [];
  const frames: Uint8Array[] = [];
  const service = new HostDownloadService({ indexPath: join(dir, "artifacts.json"),
    resolveMessageReference: (id, deviceId) => refs.resolve(id, deviceId),
    resolvePreviewReference: (id, deviceId) => refs.resolveIdentity(id, deviceId),
    publishEvent: (_device, _runtime, event) => events.push(event),
    publishMessage: (_device, reply) => replies.push(RelayToDeviceMessageSchema.parse(reply)),
    publishBinary: (_device, payload) => frames.push(payload), maxConcurrent: 1 });
  const ref = (name: string, device = "phone") => refs.register(name, dir, device, "session")!.referenceId;
  const page = randomUUID();
  const web = (path: string, resource?: string, extra: Record<string, unknown> = {}) => {
    const transferId = randomUUID();
    return { transferId, command: { type: "file.download", path, web: { page, transferId, ...(resource === undefined ? {} : { resource }), ...extra } } as const };
  };
  return { dir, service, events, replies, frames, ref, page, web };
};
const started = (reply: RelayToDeviceMessage | undefined) => {
  if (reply?.type !== "file.preview.started") throw new Error(`expected preview offer, got ${JSON.stringify(reply)}`);
  return reply;
};

// A page an agent would really write: scripts, custom properties, grid and media queries (FILE-PREVIEW-01 rejected all of these).
const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css">
<style>:root{--accent:#6b5cff}main{display:grid;grid-template-columns:1fr 1fr}@media (max-width:600px){main{display:block}}</style></head>
<body><main><h1 style="color:var(--accent)">Report</h1><canvas id="c"></canvas></main><script>document.title="ok"</script>
<pre>${"row,value\n".repeat(20_000)}</pre></body></html>`;

describe("FILE-PREVIEW-03 web preview", () => {
  // SC124 / SC126: the original page, compressed, with the first range in the reply; the digest covers decoded bytes.
  it("serves the original page compressed and sends its first range with the reply", async () => {
    const { dir, service, replies, frames, events, ref, web } = await fixture();
    await writeFile(join(dir, "report.html"), page);
    const { transferId, command } = web(ref("report.html"));
    expect(RuntimeCommandSchema.parse(command)).toEqual(command);
    expect(await service.offerDownload("phone", "host", "preview:entry", command)).toBe(true);
    const reply = started(replies.at(-1));
    expect(reply).toMatchObject({ transferId, format: "web", encoding: "deflate-raw", resource: "report.html",
      mimeType: "text/html; charset=utf-8", contentSize: Buffer.byteLength(page), sha256: digest(Buffer.from(page)) });
    expect(reply.size).toBeLessThan(reply.contentSize! / 4);
    expect(JSON.stringify(reply)).not.toContain(dir);
    expect(frames).toHaveLength(1);
    const first = decodeArtifactChunkFrame(frames[0]!);
    expect(first).toMatchObject({ transferId, offset: 0 });
    expect(first.data.byteLength).toBe(Math.min(FILE_PREVIEW_CHUNK_BYTES, reply.size));
    for (let offset = first.data.byteLength; offset < reply.size; offset += FILE_PREVIEW_CHUNK_BYTES) {
      await service.handleRead("phone", { transferId, requestId: `r${offset}`, offset, length: Math.min(FILE_PREVIEW_CHUNK_BYTES, reply.size - offset) });
    }
    const body = inflateRawSync(Buffer.concat(frames.map(frame => decodeArtifactChunkFrame(frame).data)));
    expect(body.toString()).toBe(page);
    expect(service.handleDone("phone", transferId)).toBe(true);
    expect(events).toEqual([]);
  });

  // SC126: reopening an unchanged page or resource costs a reply, not a body.
  it("answers an unchanged file without a body and resends a changed one", async () => {
    const { dir, service, replies, frames, ref, web } = await fixture();
    await writeFile(join(dir, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
    const known = digest(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'));
    const cached = web(ref("figure.svg"), undefined, { ifNoneMatch: known });
    expect(await service.offerDownload("phone", "host", "preview:cached", cached.command)).toBe(true);
    expect(started(replies.at(-1))).toMatchObject({ notModified: true, sha256: known, encoding: "identity", mimeType: "image/svg+xml" });
    expect(frames).toEqual([]);
    expect(service.handleDone("phone", cached.transferId)).toBe(false);
    await writeFile(join(dir, "figure.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    const changed = web(ref("figure.svg"), undefined, { ifNoneMatch: known });
    expect(await service.offerDownload("phone", "host", "preview:changed", changed.command)).toBe(true);
    expect(started(replies.at(-1)).notModified).toBeUndefined();
    expect(frames).toHaveLength(1);
  });

  // SC129: an agent rewriting its report (write a new file, rename over the old) leaves both cards openable;
  // only a read that started on the earlier file rejects the swap.
  it("previews a rewritten page and rejects a swap during one read", async () => {
    const { dir, service, replies, ref, web } = await fixture();
    const path = join(dir, "report.html");
    await writeFile(path, "<p>first</p>");
    const reference = ref("report.html");
    expect(await service.offerDownload("phone", "host", "preview:first", web(reference).command)).toBe(true);
    const first = started(replies.at(-1));
    const before = await stat(path, { bigint: true });
    await writeFile(join(dir, "report.html.tmp"), "<p>second, longer</p>");
    await rename(join(dir, "report.html.tmp"), path);
    expect(await service.offerDownload("phone", "host", "preview:second", web(reference).command)).toBe(true);
    const second = started(replies.at(-1));
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.contentSize).toBe(Buffer.byteLength("<p>second, longer</p>"));
    const target = await locateWebPreview(path, undefined, undefined);
    if ("reason" in target) throw new Error(target.reason);
    expect(await readWebPreview(target, `${before.dev}:${before.ino}:${before.birthtimeNs}`)).toEqual({ reason: "unavailable" });
  });

  // SC124: a legacy-encoded page keeps its own charset declaration instead of being forced to UTF-8.
  it("declares UTF-8 only for bodies that are UTF-8", async () => {
    const { dir, service, replies, ref, web } = await fixture();
    await writeFile(join(dir, "legacy.html"), Buffer.from([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e]));
    await service.offerDownload("phone", "host", "preview:legacy", web(ref("legacy.html")).command);
    expect(started(replies.at(-1)).mimeType).toBe("text/html");
  });

  // SC125: what the WebView may ask for is bounded by the site root, hidden paths, symlinks and listed types.
  it("serves only listed files below the page's site root", async () => {
    const { dir, service, replies, ref, web } = await fixture();
    await mkdir(join(dir, "docs", "page"), { recursive: true });
    await mkdir(join(dir, "docs", "shared"), { recursive: true });
    await mkdir(join(dir, ".build", "demo"), { recursive: true });
    await writeFile(join(dir, "docs", "page", "index.html"), "<p>page</p>");
    await writeFile(join(dir, "docs", "page", "style.css"), "p{color:red}");
    await writeFile(join(dir, "docs", "shared", "theme.css"), "p{color:blue}");
    await writeFile(join(dir, "docs", "page", ".private.css"), "p{}");
    await writeFile(join(dir, "docs", "page", "bundle.zip"), "zip");
    await writeFile(join(dir, ".env"), "TOKEN=1");
    await writeFile(join(dir, ".build", "demo", "index.html"), "<p>built</p>");
    await writeFile(join(dir, ".build", "demo", "app.js"), "1");
    const outside = await testDirectory(join(tmpdir(), "orbis-web-outside-"));
    await writeFile(join(outside, "secret.css"), "p{}");
    if (process.platform !== "win32") await symlink(join(outside, "secret.css"), join(dir, "docs", "page", "linked.css"));
    const entry = ref("docs/page/index.html");
    const ask = async (resource: string, path = entry) => {
      await service.offerDownload("phone", "host", `preview:${resource}`, web(path, resource).command);
      const reply = replies.at(-1)!;
      return reply.type === "file.preview.started" ? `ok:${reply.resource}` : reply.type === "file.preview.failed" ? reply.reason : reply.type;
    };
    expect(await ask("docs/page/style.css")).toBe("ok:docs/page/style.css");
    expect(await ask("/docs/shared/theme.css")).toBe("ok:docs/shared/theme.css");
    expect(await ask("docs/page/.private.css")).toBe("unavailable");
    expect(await ask(".env")).toBe("unavailable");
    expect(await ask("docs/../.env")).toBe("unavailable");
    expect(await ask("../outside.css")).toBe("unavailable");
    expect(await ask("docs\\page\\style.css")).toBe("unavailable");
    expect(await ask("docs/page/bundle.zip")).toBe("unsupported");
    expect(await ask("docs/page/missing.css")).toBe("unavailable");
    if (process.platform !== "win32") expect(await ask("docs/page/linked.css")).toBe("unavailable");
    // A page inside a hidden build folder may load its own files, but nothing hidden below that folder.
    const built = ref(".build/demo/index.html");
    expect(await ask(".build/demo/app.js", built)).toBe("ok:.build/demo/app.js");
    expect(await ask(".build/demo/.cache/x.js", built)).toBe("unavailable");
  });

  // SC127: one open page per device; a newer page supersedes older previews but never a download; bounded concurrency.
  it("keeps one page per device and leaves ordinary downloads alone", async () => {
    const { dir, service, replies, events, ref, web } = await fixture();
    await writeFile(join(dir, "a.html"), "<p>a</p>");
    for (let index = 0; index < 8; index += 1) await writeFile(join(dir, `r${index}.css`), `p{order:${index}}`.repeat(20_000));
    expect(await service.offerDownload("phone", "host", "download", { type: "file.download", path: ref("a.html") })).toBe(true);
    const transfers: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const request = web(ref("a.html"), `r${index}.css`);
      transfers.push(request.transferId);
      await service.offerDownload("phone", "host", `preview:r${index}`, request.command);
    }
    expect(replies.slice(0, 6).every(reply => reply.type === "file.preview.started")).toBe(true);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", commandId: "preview:r6", reason: "busy" });
    const next = web(ref("a.html"));
    const other = { ...next.command, web: { ...next.command.web, page: randomUUID() } };
    expect(await service.offerDownload("phone", "host", "preview:other-page", other)).toBe(true);
    for (const transferId of transfers.slice(0, 6)) expect(service.handleDone("phone", transferId)).toBe(false);
    expect(service.activeDownloads).toBe(2); // the ordinary download and the new page's entry
    expect(events).toEqual([expect.objectContaining({ type: "artifact.started" })]);
  });

  it("checks size and identity before reading and never accepts a raw path or another device's reference", async () => {
    const { dir, service, replies, frames, ref, web } = await fixture();
    const large = await open(join(dir, "large.html"), "w");
    await large.truncate(WEB_PREVIEW_ENTRY_BYTES + 1); await large.close();
    expect(await service.offerDownload("phone", "host", "preview:large", web(ref("large.html")).command)).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "too_large" });
    await writeFile(join(dir, "index.html"), "<h1>Report</h1>");
    for (const target of [join(dir, "index.html"), ref("index.html", "other-phone")]) {
      expect(await service.offerDownload("phone", "host", "preview:foreign", web(target).command)).toBe(false);
      expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "unavailable" });
    }
    await writeFile(join(dir, "notes.txt"), "text");
    expect(await service.offerDownload("phone", "host", "preview:not-a-page", web(ref("notes.txt")).command)).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "unsupported" });
    await mkdir(join(dir, "folder.html"));
    expect(await service.offerDownload("phone", "host", "preview:directory", web(ref("folder.html")).command)).toBe(false);
    expect(frames).toEqual([]);
    expect(service.activeDownloads).toBe(0);
    const { command } = web(ref("index.html"));
    expect(RuntimeCommandSchema.safeParse({ ...command, maxBytes: 10 }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ ...command, web: { ...command.web, transferId: "not-a-uuid" } }).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ type: "file.download", path: "x", maxBytes: 10 }).success).toBe(false);
  });
});

describe("FILE-PREVIEW-02", () => {
  // SC122: each native format uses its own budget and only matching file bytes can be offered.
  it("keeps native bounds and does not let a media request become an unrestricted download", async () => {
    const { dir, service, ref, replies, events, frames } = await fixture();
    await writeFile(join(dir, "picture.png"), "not an image");
    const png = { type: "file.download", path: ref("picture.png"), previewFormat: "png" } as const;
    expect(RuntimeCommandSchema.safeParse(png).success).toBe(false);
    expect(RuntimeCommandSchema.safeParse({ ...png, maxBytes: NATIVE_FILE_PREVIEW_BYTES.png + 1 }).success).toBe(false);
    expect(await service.offerDownload("phone", "host", "native-without-bound", png)).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "invalid_request" });
    expect(await service.offerDownload("phone", "host", "bad-signature", { ...png, maxBytes: NATIVE_FILE_PREVIEW_BYTES.png })).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "unsupported" });
    expect(await service.offerDownload("phone", "host", "wrong-format", { ...png, previewFormat: "pdf", maxBytes: 100 })).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "unsupported" });
    await writeFile(join(dir, "log.txt"), "x".repeat(NATIVE_FILE_PREVIEW_BYTES.text + 1));
    expect(await service.offerDownload("phone", "host", "native-too-large", { type: "file.download", path: ref("log.txt"),
      previewFormat: "text", maxBytes: NATIVE_FILE_PREVIEW_BYTES.text })).toBe(false);
    expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "too_large" });
    expect(events).toEqual([]); expect(frames).toEqual([]);
  });

  // SC117: a slow first selection retains only the newest selection, not a queue of readers.
  it("coalesces rapid selections while an earlier path is still resolving", async () => {
    const { dir } = await fixture();
    const path = join(dir, "notes.txt");
    await writeFile(path, "Most recent selection");
    const info = await stat(path, { bigint: true });
    const reference = { path, identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` };
    let resolveFirst!: (result: typeof reference) => void;
    const first = new Promise<typeof reference>(resolve => { resolveFirst = resolve; });
    const replies: RelayToDeviceMessage[] = [], paths: string[] = [];
    const service = new HostDownloadService({ indexPath: join(dir, "artifacts.json"),
      resolvePreviewReference: id => { paths.push(id); return paths.length === 1 ? first : Promise.resolve(reference); },
      publishEvent: () => { throw new Error("preview generated a runtime event"); },
      publishBinary: () => { throw new Error("native preview pushed unsolicited bytes"); },
      publishMessage: (_, reply) => replies.push(reply) });
    const offer = (label: string) => service.offerDownload("phone", "host", `preview:${label}`, {
      type: "file.download", path: `orbis-message-file:${label}`, previewFormat: "text", maxBytes: NATIVE_FILE_PREVIEW_BYTES.text });
    const initial = offer("first"), middle = offer("middle"), latest = offer("latest");
    resolveFirst(reference);
    expect(await Promise.all([initial, middle, latest])).toEqual([false, false, true]);
    expect(paths).toEqual(["orbis-message-file:first", "orbis-message-file:latest"]);
    expect(replies).toEqual([expect.objectContaining({ type: "file.preview.started", commandId: "preview:latest" })]);
    service.releaseDevice("phone");
  });
});
