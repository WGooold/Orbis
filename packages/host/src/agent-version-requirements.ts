import type { AgentKind } from "@orbis/protocol";
import { CLAUDE_MIN_VERSION } from "./claude-version.js";
import { KIMI_DESKTOP_SERVER_VERSION, KIMI_WEB_VERSION } from "./kimi-web-client.js";
import { OPENCLAW_LAUNCH_VERSION } from "./openclaw-local-launch.js";
import { OPENCODE_CLIENT_VERSION } from "./opencode-service-connection.js";

type AgentVersionRequirement =
  | { kind: "minimum" | "exact" | "embeddedService" | "localLaunch" | "baseline" | "reference"; version: string }
  | { kind: "unknown" };

// HOST-AGENT-VERSION-DSH-01: shared known-good Web and Desktop protocol baseline, not a semver range.
const DSH_BASELINE_VERSION = "0.2.2-rc.2";

/** HOST-AGENT-VERSION-01: desktop metadata, not a launch gate or a paired-protocol field. */
export const agentVersionRequirements = {
  codex: { kind: "reference", version: "0.167.0" }, // ADR-0032: real CLI; further compatibility is capability-based.
  codexDesktop: { kind: "unknown" }, // ADR-0022 / ADR-0096: platform-dependent app and bundled server.
  claude: { kind: "minimum", version: CLAUDE_MIN_VERSION },
  dsh: { kind: "baseline", version: DSH_BASELINE_VERSION },
  dshDesktop: { kind: "baseline", version: DSH_BASELINE_VERSION },
  pi: { kind: "reference", version: "0.84.4" }, // ADR-0052: integration baseline, not an extension peer minimum.
  kimiCode: { kind: "exact", version: KIMI_WEB_VERSION },
  kimiCodeDesktop: { kind: "embeddedService", version: KIMI_DESKTOP_SERVER_VERSION },
  opencode: { kind: "exact", version: OPENCODE_CLIENT_VERSION },
  hermes: { kind: "reference", version: "0.22.5" }, // ADR-0087: local Gateway command baseline.
  openclaw: { kind: "localLaunch", version: OPENCLAW_LAUNCH_VERSION }, // Existing Gateways negotiate protocol and capabilities.
  agy: { kind: "unknown" }, // Antigravity ACP does not expose a comparable local version fact.
} as const satisfies Record<AgentKind, AgentVersionRequirement>;
