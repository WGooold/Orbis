import { z } from "zod";

/** ADR-0095: symmetric opt-in; never infer the peer's parser from the protocol number. */
export const CODEX_UNIFIED_HISTORY = "codex.history-unified.v1";
export const CodexLaunchModeSchema = z.enum(["desktop", "terminal"]);
export type CodexLaunchMode = z.infer<typeof CodexLaunchModeSchema>;
