import { describe, expect, it } from "vitest";
import { orbisEnvironment } from "./product-environment.js";

describe("Orbis environment compatibility", () => {
  it("prefers the Orbis setting, including an explicit empty value", () => {
    expect(orbisEnvironment({ ORBIS_ADMIN_TOKEN: "new", PI_REMOTE_ADMIN_TOKEN: "old" }, "ADMIN_TOKEN")).toBe("new");
    expect(orbisEnvironment({ ORBIS_ENABLED: "", PI_REMOTE_ENABLED: "true" }, "ENABLED")).toBe("");
  });

  it("accepts existing settings without requiring a credential rewrite", () => {
    expect(orbisEnvironment({ PI_REMOTE_RUNTIME_CREDENTIAL: "existing" }, "RUNTIME_CREDENTIAL")).toBe("existing");
    expect(orbisEnvironment({}, "RUNTIME_CREDENTIAL")).toBeUndefined();
  });
});
