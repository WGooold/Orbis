import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const flow = runInNewContext(`${readFileSync(new URL("../packages/windows-host/src/qml/ProviderFlow.js", import.meta.url), "utf8")}\n({applyDiscoveredModels, newModel, defaultReasoningEfforts, reasoningMode, editReasoningEffort})`);

it("uses Pi defaults and editable thinking depth defaults for new DSH models", () => {
  expect(flow.newModel("pi")).toMatchObject({
    id: "",
    name: "",
    input: ["text"],
    contextWindow: "",
    maxTokens: "",
    reasoning: false,
  });
  expect(flow.newModel("dsh")).toMatchObject({
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoningEfforts: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  });
});

it("edits individual reasoning fields while preserving custom values and explicit modes", () => {
  const original = { off: "none", medium: "balanced", high: "deep" };
  const edited = flow.editReasoningEffort(original, "high", " thorough ", true);
  expect(edited).toEqual({ off: "none", medium: "balanced", high: "thorough" });
  expect(original.high).toBe("deep");
  expect(flow.editReasoningEffort(edited, "off", "", true).off).toBeNull();
  expect(flow.editReasoningEffort(edited, "medium", "", false)).toEqual({ off: "none", high: "thorough" });
  expect(flow.editReasoningEffort({ high: "high" }, "high", "", false)).toBe(false);
  expect(flow.reasoningMode(undefined)).toBe("inherit");
  expect(flow.reasoningMode(false)).toBe("disabled");
  expect(flow.reasoningMode(edited)).toBe("custom");
  const first = flow.newModel("dsh");
  first.reasoningEfforts.high = "custom";
  expect(flow.newModel("dsh").reasoningEfforts.high).toBe("high");
});

it("adds or selects discovered models without replacing existing capabilities or introducing duplicates", () => {
  for (const kind of ["pi", "dsh"]) {
    const existing = { id: "existing", name: "My model", contextWindow: 64000, future: true };
    const current = [existing, flow.newModel(kind)];
    const selection = [{ id: "existing", name: "Changed" }, { id: "first", name: "First" }, { id: "second", name: "Second" }];
    const merged = flow.applyDiscoveredModels(kind, current, selection, "existing", -1);
    expect(merged.models.map(row => row.id)).toEqual(["existing", "first", "second"]);
    expect(merged.models[0]).toEqual(existing);
    expect(merged.models[1]).toEqual(flow.newModel(kind, "first", "First"));
    expect(merged.defaultModel).toBe("existing");
    expect(flow.applyDiscoveredModels(kind, merged.models, selection, "existing", -1).models).toEqual(merged.models);
    const changed = flow.applyDiscoveredModels(kind, current, [selection[1]], "existing", 0);
    expect(changed.models[0]).toEqual({ ...existing, id: "first" });
    expect(changed.defaultModel).toBe("first");
    expect(flow.applyDiscoveredModels(kind, merged.models, [selection[1]], "existing", 0)).toHaveProperty("error");
    expect(flow.applyDiscoveredModels(kind, current, [], "existing", -1)).toEqual({ models: current, defaultModel: "existing" });
    expect(current).toEqual([existing, flow.newModel(kind)]);
  }
});
