import type { AgentKind } from "@orbis/protocol";

/** Platform policy for the standalone CLI, kept pure so server defaults are testable off Linux. */
export type HostCliProfile = {
  headless: boolean;
  launchDesktopAgents: boolean;
};

export function hostCliProfile(platform: NodeJS.Platform): HostCliProfile {
  const linuxHeadless = platform === "linux";
  return {
    headless: linuxHeadless,
    launchDesktopAgents: !linuxHeadless,
  };
}

// An eligible kind can be configured; availability still depends on its own installation,
// credentials and connection. Linux Claude needs a terminal until a managed PTY is supported.
export const linuxCliEligible = {
  pi: true, codex: true, dsh: true, hermes: true, kimiCode: true, openclaw: true, opencode: true, agy: true,
  codexDesktop: false, dshDesktop: false, kimiCodeDesktop: false, claude: false,
} as const satisfies Record<AgentKind, boolean>;

export function cliExposesAgent(platform: NodeJS.Platform, kind: AgentKind, agyAllowed: boolean): boolean {
  return (platform !== "linux" || linuxCliEligible[kind]) && (kind !== "agy" || agyAllowed);
}
