import { z } from "zod";

export const NativePreviewFormatSchema = z.enum(["jpeg", "png", "pdf", "text", "mp4"]);
export type NativePreviewFormat = z.infer<typeof NativePreviewFormatSchema>;

export const HOST_FEATURE_NATIVE_FILE_PREVIEW = "file.preview-v2";
export const NATIVE_FILE_PREVIEW_BYTES: Readonly<Record<NativePreviewFormat, number>> = Object.freeze({
  jpeg: 8 * 1024 * 1024, png: 8 * 1024 * 1024, pdf: 12 * 1024 * 1024, text: 256 * 1024, mp4: 16 * 1024 * 1024,
});
export const MAX_NATIVE_FILE_PREVIEW_BYTES = NATIVE_FILE_PREVIEW_BYTES.mp4;

export function nativeFilePreviewFormat(name: string): NativePreviewFormat | undefined {
  switch (/\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase()) {
    case "jpg": case "jpeg": return "jpeg";
    case "png": return "png";
    case "pdf": return "pdf";
    case "txt": case "md": case "log": case "json": case "csv": return "text";
    case "mp4": return "mp4";
    default: return undefined;
  }
}

/**
 * FILE-PREVIEW-03: the original page runs in an offline App WebView. The Host serves the entry and,
 * only when that WebView asks, files below the page's site root. Each response is one bounded transfer.
 */
export const HOST_FEATURE_WEB_PREVIEW = "file.preview-web-v1";
export const WEB_PREVIEW_ENTRY_BYTES = 4 * 1024 * 1024;
export const WEB_PREVIEW_RESOURCE_BYTES = 8 * 1024 * 1024;
export const WebPreviewEncodingSchema = z.enum(["identity", "deflate-raw"]);
export type WebPreviewEncoding = z.infer<typeof WebPreviewEncodingSchema>;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
export const WebPreviewRequestSchema = z.strictObject({
  /** One open page in the App. A new page supersedes the device's earlier preview transfers. */
  page: uuid,
  /** Chosen by the App so the first chunk, sent with the reply, has an owner regardless of lane order. */
  transferId: uuid,
  /** Decoded URL path below the site root, `/`-separated. Omitted for the entry itself. */
  resource: z.string().min(1).max(1024).optional(),
  /** SHA-256 of the decoded body the App already holds; an equal file is answered without a body. */
  ifNoneMatch: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
});
export type WebPreviewRequest = z.infer<typeof WebPreviewRequestSchema>;

type WebPreviewType = { mimeType: string; compress: boolean };
const webTypes: Readonly<Record<string, WebPreviewType>> = Object.freeze({
  html: { mimeType: "text/html; charset=utf-8", compress: true },
  htm: { mimeType: "text/html; charset=utf-8", compress: true },
  svg: { mimeType: "image/svg+xml", compress: true },
  css: { mimeType: "text/css; charset=utf-8", compress: true },
  js: { mimeType: "text/javascript; charset=utf-8", compress: true },
  mjs: { mimeType: "text/javascript; charset=utf-8", compress: true },
  json: { mimeType: "application/json", compress: true },
  txt: { mimeType: "text/plain; charset=utf-8", compress: true },
  csv: { mimeType: "text/csv; charset=utf-8", compress: true },
  md: { mimeType: "text/markdown; charset=utf-8", compress: true },
  xml: { mimeType: "application/xml", compress: true },
  wasm: { mimeType: "application/wasm", compress: true },
  ttf: { mimeType: "font/ttf", compress: true },
  otf: { mimeType: "font/otf", compress: true },
  woff: { mimeType: "font/woff", compress: false },
  woff2: { mimeType: "font/woff2", compress: false },
  png: { mimeType: "image/png", compress: false },
  jpg: { mimeType: "image/jpeg", compress: false },
  jpeg: { mimeType: "image/jpeg", compress: false },
  gif: { mimeType: "image/gif", compress: false },
  webp: { mimeType: "image/webp", compress: false },
  avif: { mimeType: "image/avif", compress: false },
  ico: { mimeType: "image/x-icon", compress: false },
});

/** Pages are `.html`, `.htm` or `.svg`; everything else a page may load is a resource. */
export function webPreviewEntryType(name: string): WebPreviewType | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase();
  return extension === "html" || extension === "htm" || extension === "svg" ? webTypes[extension] : undefined;
}

/** Media streams and archives stay with ordinary downloads; WebView range playback is not modelled here. */
export function webPreviewResourceType(name: string): WebPreviewType | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase();
  return extension === undefined ? undefined : webTypes[extension];
}
