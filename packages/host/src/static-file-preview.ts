import { webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { NativePreviewFormat } from "@orbis/protocol";

export type StaticPreviewFormat = "html" | "svg";
export type StaticPreviewResult = { bytes: Uint8Array; sha256: string } | { reason: "unavailable" | "too_large" | "unsupported" };

/** Check size before opening and again on the handle. Prepare exactly one bounded snapshot. */
async function readPreviewBytes(path: string, maxBytes: number, identity?: string): Promise<Uint8Array | Extract<StaticPreviewResult, { reason: string }>> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { reason: "unavailable" };
    if (info.size > maxBytes) return { reason: "too_large" };
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || (identity !== undefined && identity !== `${before.dev}:${before.ino}:${before.birthtimeNs}`)) return { reason: "unavailable" };
      if (before.size > BigInt(maxBytes)) return { reason: "too_large" };
      const bytes = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return { reason: "unavailable" };
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return { reason: "unavailable" };
      return bytes;
    } finally { await handle.close(); }
  } catch { return { reason: "unavailable" }; }
}

export async function readNativeFilePreview(path: string, format: NativePreviewFormat, maxBytes: number, identity?: string): Promise<StaticPreviewResult> {
  const bytes = await readPreviewBytes(path, maxBytes, identity);
  if (!(bytes instanceof Uint8Array)) return bytes;
  if (bytes.length === 0) return { reason: "unsupported" };
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 12));
  const match = (() => {
    switch (format) {
      case "jpeg": return header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
      case "png": return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      case "pdf": return header.toString("ascii", 0, 5) === "%PDF-";
      case "mp4": return header.length === 12 && header.toString("latin1", 4, 8) === "ftyp";
      case "text": {
        if (bytes.includes(0)) return false;
        try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
      }
    }
  })();
  if (!match) return { reason: "unsupported" };
  // WebCrypto uses the worker pool rather than hashing multi-megabyte bodies on the Host's event loop.
  return { bytes, sha256: Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex") };
}

export async function readStaticFilePreview(path: string, format: StaticPreviewFormat, maxBytes: number, identity?: string, documentBytes = maxBytes): Promise<StaticPreviewResult> {
  const bytes = await readPreviewBytes(path, maxBytes, identity);
  if (!(bytes instanceof Uint8Array)) return bytes;
  try {
    // Retain the ordinary tsc-built worker in packaged Hosts; the TypeScript path supports Vitest's source imports.
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = new Worker(new URL(`./static-file-preview-worker.${extension}`, import.meta.url), {
      workerData: { orbisStaticFilePreview: true, bytes, format, maxBytes: documentBytes },
      transferList: [bytes.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    return await new Promise<StaticPreviewResult>(resolve => {
      let done = false;
      const finish = (result: StaticPreviewResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer); void worker.terminate(); resolve(result);
      };
      const timer = setTimeout(() => finish({ reason: "unsupported" }), 2_000);
      timer.unref();
      worker.once("message", (result: StaticPreviewResult) => finish(result));
      worker.once("error", () => finish({ reason: "unsupported" }));
      worker.once("exit", () => finish({ reason: "unsupported" }));
    });
  } catch { return { reason: "unavailable" }; }
}
