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
