import { createHash } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testDirectory } from "../../../scripts/test-fixtures/temp-directory.js";
import { FILE_PREVIEW_BYTES, FILE_PREVIEW_CHUNK_BYTES, NATIVE_FILE_PREVIEW_BYTES, RelayToDeviceMessageSchema, RuntimeCommandSchema, decodeArtifactChunkFrame,
  type RelayToDeviceMessage, type RuntimeEvent } from "@orbis/protocol";
import { HostDownloadService } from "./artifact-download.js";
import { MessageFileReferences } from "./message-file-references.js";
import { readStaticFilePreview } from "./static-file-preview.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fixture = async () => {
  const dir = await testDirectory(join(tmpdir(), "orbis-static-preview-"));
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
  return { dir, service, events, replies, frames,
    ref: (name: string, device = "phone") => refs.register(name, dir, device, "session")!.referenceId };
};

describe("FILE-PREVIEW-01", () => {
  // SC118 / SC120: the bound is opt-in, checked on the Host, and does not constrain ordinary downloads.
  it("rejects a too-large selected file before offering ranges but preserves the ordinary download", async () => {
    const { dir, service, events, replies, frames, ref } = await fixture();
    const path = join(dir, "report.html");
    const fd = await open(path, "w");
    await fd.truncate(FILE_PREVIEW_BYTES + 1); await fd.close();
    const download = { type: "file.download", path: ref("report.html") } as const;
    expect(RuntimeCommandSchema.safeParse({ ...download, maxBytes: FILE_PREVIEW_BYTES + 1 }).success).toBe(false);
    expect(RuntimeCommandSchema.parse(download)).toEqual(download);
    expect(await service.offerDownload("phone", "host", "preview:large", { ...download, maxBytes: FILE_PREVIEW_BYTES })).toBe(false);
    expect(replies).toEqual([expect.objectContaining({ type: "file.preview.failed", reason: "too_large" })]);
    expect(events).toEqual([]);
    expect(frames).toEqual([]);
    expect(service.activeDownloads).toBe(0);
    expect(await service.offerDownload("phone", "host", "download", download)).toBe(true);
    expect(events).toEqual([expect.objectContaining({ type: "artifact.started", artifact: expect.objectContaining({ size: FILE_PREVIEW_BYTES + 1 }) })]);
    service.releaseDevice("phone");
  });

  // SC116 / SC117: an independent, opt-in snapshot with the exact bytes the receiver will verify.
  it("serves one admitted range at a time from the prepared version; cancellation does not touch a download", async () => {
    const { service, events, replies, frames, dir, ref } = await fixture();
    const body = `<main><h1>Report</h1><pre>${"x".repeat(FILE_PREVIEW_CHUNK_BYTES + 1)}</pre></main>`;
    const path = join(dir, "report.html");
    await writeFile(path, body);
    const target = { type: "file.download", path: ref("report.html") } as const;
    expect(await service.offerDownload("phone", "host", "download", target)).toBe(true);
    expect(await service.offerDownload("phone", "host", "preview:snapshot", { ...target, maxBytes: FILE_PREVIEW_BYTES })).toBe(true);
    const ready = replies.at(-1);
    if (ready?.type !== "file.preview.started") throw new Error("expected preview offer");
    expect(ready).toMatchObject({ referenceId: target.path, format: "html" });
    expect(JSON.stringify(ready)).not.toContain(dir);
    expect(frames).toEqual([]); // nothing is pushed with metadata
    await writeFile(path, body.replace("Report", "Edited")); // same byte length
    await service.handleRead("another-phone", { transferId: ready.transferId, requestId: "foreign", offset: 0, length: 1 });
    await service.handleRead("phone", { transferId: ready.transferId, requestId: "too-wide", offset: 0, length: FILE_PREVIEW_CHUNK_BYTES + 1 });
    expect(replies.at(-1)).toMatchObject({ type: "artifact.read.failed", requestId: "too-wide", reason: "range_out_of_bounds" });
    expect(frames).toEqual([]);
    for (let offset = 0; offset < ready.size; offset += FILE_PREVIEW_CHUNK_BYTES) {
      await service.handleRead("phone", { transferId: ready.transferId, requestId: `range:${offset}`, offset,
        length: Math.min(FILE_PREVIEW_CHUNK_BYTES, ready.size - offset) });
    }
    expect(frames).toHaveLength(2);
    const combined = Buffer.concat(frames.map(frame => decodeArtifactChunkFrame(frame).data));
    expect(digest(combined)).toBe(ready.sha256);
    expect(combined.toString()).toContain("<h1>Report</h1>");
    expect(combined.toString()).not.toContain("Edited");
    expect(service.handleTransferControl("phone", "host", { type: "artifact.cancel", transferId: ready.transferId })).toBe(true);
    await service.handleRead("phone", { transferId: ready.transferId, requestId: "late", offset: 0, length: 1 });
    expect(replies.at(-1)).toMatchObject({ type: "artifact.read.failed", reason: "unknown_transfer" });
    expect(service.activeDownloads).toBe(1);
    expect(events).toHaveLength(1);
    service.releaseDevice("phone");
  });

  // SC119: disabled resource classes are rejected rather than pulled from the Host or the network.
  it("accepts an ordinary exported SVG with a namespace and rejects dependent or active documents", async () => {
    const { dir } = await fixture();
    const svg = join(dir, "figure.svg");
    await writeFile(svg, '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#800" d="M0 0L24 24"/></svg>');
    const result = await readStaticFilePreview(svg, "svg", FILE_PREVIEW_BYTES);
    expect("bytes" in result && Buffer.from(result.bytes).toString()).toContain('<svg viewBox="0 0 24 24">');
    const html = join(dir, "index.html");
    for (const body of ['<link rel="stylesheet" href="report.css"><p>Report</p>', '<img src="figure.png">',
      '<script src="plot.js"></script>', '<style>@import "report.css";</style>', '<style>p{animation:pulse 1s infinite}</style>',
      '<meta http-equiv="refresh" content="0;url=fixture.invalid">', '<svg><animate attributeName="x"/></svg>']) {
      await writeFile(html, body);
      await expect(readStaticFilePreview(html, "html", FILE_PREVIEW_BYTES)).resolves.toEqual({ reason: "unsupported" });
    }
    await writeFile(html, '<style>p{color:rgb(80, 90, 160)}</style><p><a href="report.zip">Report</a></p>');
    const safe = await readStaticFilePreview(html, "html", FILE_PREVIEW_BYTES);
    expect("bytes" in safe && Buffer.from(safe.bytes).toString()).toContain("<a>Report</a>");
    expect(JSON.stringify(safe)).not.toContain("report.zip");
  });

  // SC117: a slow first selection retains only the newest selection, not a queue of workers.
  it("coalesces rapid selections while an earlier path is still resolving", async () => {
    const { dir } = await fixture();
    const path = join(dir, "report.html");
    await writeFile(path, "<h1>Most recent selection</h1>");
    const info = await stat(path, { bigint: true });
    const reference = { path, identity: `${info.dev}:${info.ino}:${info.birthtimeNs}` };
    let resolveFirst!: (result: typeof reference) => void;
    const first = new Promise<typeof reference>(resolve => { resolveFirst = resolve; });
    const replies: RelayToDeviceMessage[] = [], paths: string[] = [];
    const service = new HostDownloadService({ indexPath: join(dir, "artifacts.json"),
      resolvePreviewReference: id => { paths.push(id); return paths.length === 1 ? first : Promise.resolve(reference); },
      publishEvent: () => { throw new Error("preview generated a runtime event"); },
      publishBinary: () => { throw new Error("preview pushed unsolicited bytes"); },
      publishMessage: (_, reply) => replies.push(reply) });
    const offer = (label: string) => service.offerDownload("phone", "host", `preview:${label}`, {
      type: "file.download", path: `orbis-message-file:${label}`, maxBytes: FILE_PREVIEW_BYTES });
    const initial = offer("first"), middle = offer("middle"), latest = offer("latest");
    resolveFirst(reference);
    expect(await Promise.all([initial, middle, latest])).toEqual([false, false, true]);
    expect(paths).toEqual(["orbis-message-file:first", "orbis-message-file:latest"]);
    expect(replies).toEqual([expect.objectContaining({ type: "file.preview.started", commandId: "preview:latest" })]);
    service.releaseDevice("phone");
  });

  it("checks the opened file identity and never accepts a raw path or another device’s file reference", async () => {
    const { service, replies, dir, ref } = await fixture();
    const path = join(dir, "index.html");
    await writeFile(path, "<h1>Report</h1>");
    const other = join(dir, "other.html");
    await writeFile(other, "<h1>Other</h1>");
    const info = await stat(other, { bigint: true });
    expect(await readStaticFilePreview(path, "html", FILE_PREVIEW_BYTES, `${info.dev}:${info.ino}:${info.birthtimeNs}`)).toEqual({ reason: "unavailable" });
    for (const target of [path, ref("index.html", "other-phone")]) {
      expect(await service.offerDownload("phone", "host", `preview:foreign`, { type: "file.download", path: target, maxBytes: FILE_PREVIEW_BYTES })).toBe(false);
      expect(replies.at(-1)).toMatchObject({ type: "file.preview.failed", reason: "unavailable" });
    }
    await mkdir(join(dir, "folder.html"));
    expect(await service.offerDownload("phone", "host", "preview:directory", { type: "file.download", path: ref("folder.html"), maxBytes: FILE_PREVIEW_BYTES })).toBe(false);
    expect(service.activeDownloads).toBe(0);
  });
});


describe("FILE-PREVIEW-02", () => {
  // SC122: each native format uses its own budget and only matching file bytes can be offered.
  it("does not relax the v1 budget or let a media request become an unrestricted download", async () => {
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
});
