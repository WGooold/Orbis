import { describe, expect, it } from "vitest";
import { hostCliProfile } from "./cli-profile.js";

describe("Host CLI platform policy", () => {
  // LINUX-HOST-CLI-01: Linux CLI must not depend on a desktop session and must not launch desktop-only agents.
  it("selects a headless profile and disables desktop-only agents on Linux", () => {
    expect(hostCliProfile("linux")).toEqual({ headless: true, launchDesktopAgents: false });
  });

  it.each(["darwin", "win32"] as const)("preserves existing desktop launch behavior on %s", platform => {
    expect(hostCliProfile(platform)).toEqual({ headless: false, launchDesktopAgents: true });
  });
});
