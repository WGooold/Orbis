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
