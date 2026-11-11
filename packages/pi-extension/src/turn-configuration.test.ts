import { describe, expect, it } from "vitest";
import { piTurnConfiguration } from "./turn-configuration.js";

// S56 / SC80: native response identity can differ from selected virtual model and depth.
describe("Pi native turn configuration", () => {
  it("uses only assistant request facts and preserves unknown streaming depth", () => {
    expect(piTurnConfiguration("t", { role: "user", model: "selected", provider: "p" })).toBeUndefined();
    const message = { role: "assistant", provider: "routed", model: "actual", providerThinkingLevel: "native-budget" };
    expect(piTurnConfiguration("t", message)).toEqual({ turnId: "t", model: { provider: "routed", id: "actual" } });
    expect(piTurnConfiguration("t", { ...message, thinkingLevel: "off" })).toMatchObject({ thinkingLevel: "off" });
    expect(piTurnConfiguration("next", message)?.turnId).toBe("next");
  });
});
