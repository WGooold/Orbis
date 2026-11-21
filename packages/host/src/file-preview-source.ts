import { webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
import {
  WEB_PREVIEW_ENTRY_BYTES,
  WEB_PREVIEW_RESOURCE_BYTES,
  webPreviewEntryType,
  webPreviewResourceType,
  type NativePreviewFormat,
  type WebPreviewEncoding,
} from "@orbis/protocol";

export type PreviewFailure = { reason: "unavailable" | "too_large" | "unsupported" };
export type NativePreviewResult = { bytes: Uint8Array; sha256: string } | PreviewFailure;
export type WebPreviewTarget = { path: string; resource: string; mimeType: string; compress: boolean; maxBytes: number };
export type WebPreviewBody = { body: Uint8Array; sha256: string; contentSize: number; encoding: WebPreviewEncoding; mimeType: string };

const compress = promisify(deflateRaw);
// WebCrypto uses the worker pool rather than hashing multi-megabyte bodies on the Host's event loop.
const sha256 = async (bytes: Uint8Array): Promise<string> =>
  Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex");
const inside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Check size before opening and again on the handle. Read exactly one bounded, unchanged version. */
async function readPreviewBytes(path: string, maxBytes: number, identity?: string): Promise<Uint8Array | PreviewFailure> {
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

export async function readNativeFilePreview(path: string, format: NativePreviewFormat, maxBytes: number, identity?: string): Promise<NativePreviewResult> {
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
  return { bytes, sha256: await sha256(bytes) };
}

/**
 * FILE-PREVIEW-03. The site root is the session workspace when the page was cited inside it, otherwise the
 * page's own folder. A resource is a decoded URL path below that root: no parent steps, no hidden files or
 * folders below the page's own folder, no symlink leaving the root, and only listed web types.
 */
export async function locateWebPreview(entry: string, site: string | undefined, resource: string | undefined): Promise<WebPreviewTarget | PreviewFailure> {
  try {
    const page = await realpath(entry);
    const root = site !== undefined && inside(site, page) ? site : dirname(page);
    const pageSegments = relative(root, page).split(sep);
    if (resource === undefined) {
      const type = webPreviewEntryType(page);
      return type ? { path: page, resource: pageSegments.join("/"), ...type, maxBytes: WEB_PREVIEW_ENTRY_BYTES } : { reason: "unsupported" };
    }
    const segments = resource.replace(/^\/+/u, "").split("/");
    const folder = pageSegments.slice(0, -1);
    // The page's own folder may itself be hidden (for example a build output); nothing below it may be.
    const divergence = segments.findIndex((segment, index) => segment !== folder[index]);
    const own = divergence === -1 ? segments.length : divergence;
    for (const [index, segment] of segments.entries()) {
      // eslint-disable-next-line no-control-regex
      if (segment === "" || segment === "." || segment === ".." || /[\\:\u0000-\u001f\u007f]/u.test(segment)) return { reason: "unavailable" };
      if (segment.startsWith(".") && index >= own) return { reason: "unavailable" };
    }
    const type = webPreviewResourceType(segments.at(-1)!);
    if (!type) return { reason: "unsupported" };
    const path = await realpath(join(root, ...segments));
    if (!inside(root, path)) return { reason: "unavailable" };
    return { path, resource: segments.join("/"), ...type, maxBytes: WEB_PREVIEW_RESOURCE_BYTES };
  } catch { return { reason: "unavailable" }; }
}

const utf8 = (bytes: Uint8Array): boolean => { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; } };

/**
 * Text-like bodies are sent as raw DEFLATE when that saves at least a twentieth; the digest covers decoded bytes.
 * A text body that is not UTF-8 loses the declared charset, so the page's own `<meta charset>` decides.
 */
export async function readWebPreview(target: WebPreviewTarget, identity?: string): Promise<WebPreviewBody | PreviewFailure> {
  const bytes = await readPreviewBytes(target.path, target.maxBytes, identity);
  if (!(bytes instanceof Uint8Array)) return bytes;
  if (bytes.length === 0) return { reason: "unsupported" };
  const [digest, packed] = await Promise.all([sha256(bytes), target.compress ? compress(bytes, { level: 6 }) : undefined]);
  const encoded = packed !== undefined && packed.byteLength <= bytes.byteLength * 0.95;
  const mimeType = target.mimeType.includes("charset=utf-8") && !utf8(bytes) ? target.mimeType.replace(/;\s*charset=utf-8/u, "") : target.mimeType;
  return { body: encoded ? new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength) : bytes, sha256: digest,
    contentSize: bytes.byteLength, encoding: encoded ? "deflate-raw" : "identity", mimeType };
}
