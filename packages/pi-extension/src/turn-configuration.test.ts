import { describe, expect, it } from "vitest";
import { piTurnConfiguration } from "./turn-configuration.js";
import { runtimeContextSnapshot } from "./pi-adapter.js";

// S56 / SC80: native response identity can differ from selected virtual model and depth.
describe("Pi native turn configuration", () => {
  // SC86: native message.model and context.model.id have the same identity;
  // a friendly label and provider/id command encoding do not mean a pending change.
  it("keeps unchanged selection and response identities comparable across repeated turns", () => {
    const selection = runtimeContextSnapshot({ model: { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }, thinkingLevel: "high" });
    expect(selection.modelSelection).toEqual({ model: "deepseek/deepseek-flash", thinking: "high" });
    for (const turnId of ["first", "second"]) {
      const current = piTurnConfiguration(turnId, { role: "assistant", provider: "deepseek", model: "deepseek-flash", thinkingLevel: "high" });
      expect(current?.model).toEqual({ provider: selection.model?.provider, id: selection.model?.id });
      expect(current?.thinkingLevel).toBe(selection.thinkingLevel);
    }
  });
  it("uses only assistant request facts and preserves unknown streaming depth", () => {
    expect(piTurnConfiguration("t", { role: "user", model: "selected", provider: "p" })).toBeUndefined();
    const message = { role: "assistant", provider: "routed", model: "actual", providerThinkingLevel: "native-budget" };
    expect(piTurnConfiguration("t", message)).toEqual({ turnId: "t", model: { provider: "routed", id: "actual" } });
    expect(piTurnConfiguration("t", { ...message, thinkingLevel: "off" })).toMatchObject({ thinkingLevel: "off" });
    expect(piTurnConfiguration("next", message)?.turnId).toBe("next");
  });
});
