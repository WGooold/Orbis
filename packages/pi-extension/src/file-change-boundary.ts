import type { LoopbackDescriptor } from "@orbis/protocol";
import { readLoopbackDescriptor } from "./loopback.js";

export type FileChangeBoundary = {
  runtimeId: string; sessionId: string; reviewTurnId: string; phase: "begin" | "finish";
  sourceTurnIds?: string[]; anchorEntryId?: string;
  outcome?: "completed" | "cancelled" | "failed" | "unknown";
};

/** Best effort capture must never stop/replay native execution when Host is unavailable. */
export async function fileChangeBoundary(input: FileChangeBoundary,
  descriptor: LoopbackDescriptor | undefined = undefined): Promise<boolean> {
  try {
    descriptor ??= await readLoopbackDescriptor();
    if (!descriptor) return false;
    const url = new URL("/v1/changes/boundary", descriptor.url);
    url.protocol = "http:";
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify(input) });
    return response.ok && (await response.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}
