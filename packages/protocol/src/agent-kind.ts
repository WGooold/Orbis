import { z } from "zod";

/** Agent identities on the shared wire. Publishing feature-gated kinds is the Host's responsibility. */
export const AgentKindSchema = z.enum(["pi", "codex", "codexDesktop", "dsh", "claude", "dshDesktop", "hermes", "kimiCode", "kimiCodeDesktop", "openclaw", "opencode", "agy"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;
