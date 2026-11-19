import { createHash } from "node:crypto";
import { readSessionMessageIdentity } from "@openclaw/gateway-client";
import type { ChatMessage, RemoteContent, RemoteSessionEntry } from "@orbis/protocol";
import { openClawRecord } from "./openclaw-gateway.js";

export const OPENCLAW_PREFIX = "openclaw:";
export const clawHash = (value: string): string => createHash("sha256").update(value).digest("base64url");
export const clawText = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
export const clawInt = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export const clawTime = (value: unknown): number => Math.min(clawInt(value) ?? 0, 8_640_000_000_000_000);
export const clawEntryId = (id: string): string => `claw:${clawHash(id)}`;

function textBlock(value: unknown, type: "text" | "thinking"): RemoteContent[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return [{ type, text: value }];
}

export function clawMessage(raw: Record<string, unknown>, id: string, fallbackTime = 0, clientMessageId?: string): ChatMessage | undefined {
  const role = raw.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return undefined;
  const content = typeof raw.content === "string" ? textBlock(raw.content, "text") : Array.isArray(raw.content) ? raw.content.flatMap((item: unknown) => {
    const part = openClawRecord(item);
    if (part?.type === "text") return textBlock(part.text, "text");
    if (part?.type === "thinking") return textBlock(part.thinking, "thinking");
    return [];
  }) : [];
  // Do not surface tool arguments, thought signatures, image bytes or other unprojected native metadata.
  if (content.length === 0) return undefined;
  return { messageId: id, role, content, timestamp: clawTime(raw.timestamp ?? fallbackTime),
    ...(role === "user" && clientMessageId ? { clientMessageId } : {}) };
}

export type ClawHistoryRow = { id: string; entry: Omit<RemoteSessionEntry, "parentId">; runId?: string };
export type ClawHistoryPage = { rows: ClawHistoryRow[]; older?: string; info?: Record<string, unknown>; inFlight?: Record<string, unknown> };

/** Use Gateway's occurrence identity, not text, array index, or a numeric offset. */
export function readClawHistory(value: unknown, key: string, sessionId: string, clientId: (runId: string) => string | undefined): ClawHistoryPage {
  const body = openClawRecord(value);
  if (!body || body.sessionKey !== key || body.sessionId !== sessionId || body.windowReset === true || !Array.isArray(body.messages)) {
    throw new Error("OpenClaw history no longer belongs to this session");
  }
  const info = openClawRecord(body.sessionInfo);
  const older = clawText(body.olderCursor, 4096);
  const inFlight = openClawRecord(body.inFlightRun);
  if (body.hasMore === true && !older) throw new Error("OpenClaw history has no stable continuation");
  const rows = body.messages.map((value: unknown): ClawHistoryRow => {
    const raw = openClawRecord(value);
    const identity = raw ? readSessionMessageIdentity(raw) : null;
    const nativeId = clawText(identity?.id, 1024);
    if (!raw || !nativeId) throw new Error("OpenClaw history row has no stable identity");
    const id = clawEntryId(nativeId);
    const runId = clawText(identity?.runId, 256);
    const message = clawMessage(raw, id, clueTime(raw), identity?.sendId ? clientId(identity.sendId) : undefined);
    return { id, ...(runId ? { runId } : {}), entry: { entryId: id, type: message ? "message" : "openclaw.unprojected",
      timestamp: new Date(message?.timestamp ?? clueTime(raw)).toISOString(), data: message ? { message } : {} } };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("OpenClaw history contains ambiguous identities");
  return { rows, ...(older ? { older } : {}), ...(info ? { info } : {}), ...(inFlight ? { inFlight } : {}) };
}
function clueTime(raw: Record<string, unknown>): number {
  return clawTime(raw.timestamp ?? openClawRecord(raw.__openclaw)?.recordTimestampMs);
}
