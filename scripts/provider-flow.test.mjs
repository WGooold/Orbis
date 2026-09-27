import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const flow = runInNewContext(`${readFileSync(new URL("../packages/windows-host/src/qml/ProviderFlow.js", import.meta.url), "utf8")}\n({mergeDiscoveredModels})`);

it("adds every selected model without replacing capabilities or an existing default", () => {
  for (const kind of ["codex", "pi"]) {
    const key = kind === "codex" ? "model" : "id";
    const existing = { [key]: "existing", contextWindow: 64000, future: true };
    const current = [existing, { [key]: "" }];
    const selection = [{ id: "existing", name: "Changed" }, { id: "first", name: "First" }, { id: "second", name: "Second" }];
    const merged = flow.mergeDiscoveredModels(kind, current, selection, "existing");
    expect(merged.models.map(row => row[key])).toEqual(["existing", "first", "second"]);
    expect(merged.models[0]).toEqual(existing);
    expect(merged.defaultModel).toBe("existing");
    expect(flow.mergeDiscoveredModels(kind, merged.models, selection, "").defaultModel).toBe("existing");
    expect(flow.mergeDiscoveredModels(kind, merged.models, selection, "existing").models).toEqual(merged.models);
    expect(current).toEqual([existing, { [key]: "" }]);
  }
});
