import { open, type FileHandle } from "node:fs/promises";
import type { TurnConfiguration } from "@orbis/protocol";

const HEADER_BYTES = 128 * 1024;
const DEFAULT_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const TURN_CONTEXT_NEEDLE = Buffer.from('"turn_context"');

export type ReadCodexTurnConfigurationOptions = {
  readonly chunkBytes?: number;
  readonly maxBytes?: number;
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) ? value as Record<string, unknown> : {};

type ParseResult = { readonly done: boolean; readonly value?: TurnConfiguration };

function parseTurnContextLine(line: Buffer, defaultProvider: unknown, turnId: string): ParseResult | undefined {
  // Pre-filter in native Buffer bytes so huge response_item lines never decode or JSON.parse.
  if (!line.includes(TURN_CONTEXT_NEEDLE)) return undefined;
  let row: Record<string, unknown>;
  try { row = object(JSON.parse(line.toString("utf8"))); } catch { return undefined; }
  if (row.type !== "turn_context") return undefined;
  const context = object(row.payload);
  if (context.turn_id !== turnId || typeof context.model !== "string" || !context.model || context.model.length > 256) return undefined;
  const provider = context.model_provider ?? defaultProvider;
  if (typeof provider !== "string" || !provider || provider.length > 128) return { done: true };
  const effort = context.effort;
  return {
    done: true,
    value: {
      turnId,
      model: { provider, id: context.model },
      ...(effort === null || typeof effort === "string" && effort.length > 0 && effort.length <= 64 ? { thinkingLevel: effort } : {}),
    },
  };
}

function scanReversedLines(buf: Buffer, defaultProvider: unknown, turnId: string): ParseResult | undefined {
  let lineEnd = buf.length;
  while (lineEnd > 0) {
    const nl = buf.lastIndexOf(0x0a, lineEnd - 1);
    const lineStart = nl === -1 ? 0 : nl + 1;
    const result = parseTurnContextLine(buf.subarray(lineStart, lineEnd), defaultProvider, turnId);
    if (result !== undefined) return result;
    lineEnd = nl;
  }
  return undefined;
}

async function readChunk(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await file.read(buf, total, length - total, start + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buf.subarray(0, total);
}

/** S52: read only the native-owned path and exact thread/turn. Bounded reverse-chunk scan,
 * pre-filtered before JSON parsing; contexts outside the scan limit stay unknown. */
export async function readCodexTurnConfiguration(
  path: string,
  threadId: string,
  turnId: string,
  options?: ReadCodexTurnConfigurationOptions,
): Promise<TurnConfiguration | undefined> {
  const chunkBytes = Math.max(1, Math.floor(options?.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxBytes = Math.max(0, Math.floor(options?.maxBytes ?? DEFAULT_MAX_BYTES));
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    if (size === 0) return undefined;
    const head = await readChunk(file, 0, Math.min(size, HEADER_BYTES));
    const firstLine = head.toString("utf8").split("\n")[0];
    const meta = object(JSON.parse(firstLine ?? "{}"));
    const identity = object(meta.payload);
    if (meta.type !== "session_meta" || identity.id !== threadId) return undefined;
    const floor = Math.max(0, size - maxBytes);
    let end = size;
    // A partially appended line at EOF is not yet an execution fact.
    let discardPartialEof = true;
    let trailingChunks: Buffer[] = [];
    while (end > floor) {
      const start = Math.max(floor, end - chunkBytes);
      let chunk = await readChunk(file, start, end - start);
      if (chunk.length === 0) break;
      end = start;
      if (discardPartialEof) {
        const eofNl = chunk.lastIndexOf(0x0a);
        if (eofNl === -1) continue;
        chunk = chunk.subarray(0, eofNl);
        discardPartialEof = false;
      }
      const firstNl = start > 0 ? chunk.indexOf(0x0a) : -1;
      if (start > 0 && firstNl === -1) {
        if (chunk.length > 0) trailingChunks.push(chunk);
        continue;
      }
      const lastNl = chunk.lastIndexOf(0x0a);
      const boundaryStart = lastNl === -1 ? 0 : lastNl + 1;
      const boundaryLine = trailingChunks.length === 0
        ? chunk.subarray(boundaryStart)
        : Buffer.concat([chunk.subarray(boundaryStart), ...trailingChunks.reverse()]);
      trailingChunks = [];
      const boundaryMatch = parseTurnContextLine(boundaryLine, identity.model_provider, turnId);
      if (boundaryMatch !== undefined) return boundaryMatch.value;
      if (lastNl > firstNl) {
        const inner = chunk.subarray(start > 0 ? firstNl + 1 : 0, lastNl);
        const innerMatch = scanReversedLines(inner, identity.model_provider, turnId);
        if (innerMatch !== undefined) return innerMatch.value;
      }
      if (start > 0 && firstNl > 0) trailingChunks.push(chunk.subarray(0, firstNl));
    }
    return undefined;
  } finally { await file.close(); }
}
