import { describe, expect, it } from "vitest";
import { formatRemoteTitle, remoteStatusFrame } from "./terminal-status.js";

describe("Orbis terminal status", () => {
  it("maps connection states to a stable status frame", () => {
    expect(remoteStatusFrame("connected", 0)).toEqual({
      icon: "●",
      label: "connected",
    });
    expect(remoteStatusFrame("error", 0)).toEqual({
      icon: "!",
      label: "error",
    });
    expect(remoteStatusFrame("reconnecting", 0).label).toBe("reconnecting");
    expect(remoteStatusFrame("waiting", 0)).toEqual({
      icon: "◆",
      label: "input",
    });

    // Animated states keep the label stable while the icon changes.
    const connecting = [0, 1, 2, 3].map((frame) => remoteStatusFrame("connecting", frame));
    const running = [0, 1, 2, 3].map((frame) => remoteStatusFrame("running", frame));
    expect(new Set(connecting.map((frame) => frame.icon)).size).toBeGreaterThan(1);
    expect(connecting.every((frame) => frame.label === "connecting")).toBe(true);
    expect(new Set(running.map((frame) => frame.icon)).size).toBeGreaterThan(1);
    expect(running.every((frame) => frame.label === "active")).toBe(true);
  });

  it("places the status marker in front of the normal Pi terminal title", () => {
    expect(formatRemoteTitle("π - MCC - project", remoteStatusFrame("connected", 0))).toBe(
      "● connected | π - MCC - project",
    );
    expect(formatRemoteTitle("π - project")).toBe("π - project");
  });
});
