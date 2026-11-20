import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";

export type StaticPreviewFormat = "html" | "svg";
export type StaticPreviewResult = { bytes: Uint8Array; sha256: string } | { reason: "unavailable" | "too_large" | "unsupported" };

/** Check size before opening and again on the handle. Prepare exactly one bounded snapshot. */
export async function readStaticFilePreview(path: string, format: StaticPreviewFormat, maxBytes: number, identity?: string, documentBytes = maxBytes): Promise<StaticPreviewResult> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { reason: "unavailable" };
    if (info.size > maxBytes) return { reason: "too_large" };
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
    let bytes: Uint8Array;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || (identity !== undefined && identity !== `${before.dev}:${before.ino}:${before.birthtimeNs}`)) return { reason: "unavailable" };
      if (before.size > BigInt(maxBytes)) return { reason: "too_large" };
      bytes = new Uint8Array(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return { reason: "unavailable" };
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) return { reason: "unavailable" };
    } finally { await handle.close(); }

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
