import { describe, expect, it } from "vitest";
import { claudeToolResultText } from "./claude-session-history.js";

describe("MSG-RENDER-01 Claude tool details", () => {
  it("shows verified result fields, strips paths and skips unsafe links and pending plans", () => {
    expect(claudeToolResultText("Artifact", { title: "Report", url: "https://example.test/report", path: "/private" }))
      .toBe("Report\nhttps://example.test/report");
    expect(claudeToolResultText("Artifact", { opened: true, url: "javascript:alert(1)" })).toBeUndefined();
    expect(claudeToolResultText("WebSearch", { results: [{ content: [
      { title: "Guide", url: "https://example.test/", snippet: "private" },
      { title: "duplicate", url: "https://example.test/" }, { url: "file:///private" },
    ] }] })).toBe("Guide\nhttps://example.test/");
    expect(claudeToolResultText("ExitPlanMode", { plan: "# Proposed plan", filePath: "/private" })).toBe("# Proposed plan");
    expect(claudeToolResultText("ExitPlanMode", { plan: "# Draft", awaitingLeaderApproval: true })).toBeUndefined();
  });
});
