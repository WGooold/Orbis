import { describe, expect, it } from "vitest";

import { usesHostLaunch } from "./codex-shim.js";
import { renderCodexShim } from "./codex-shim-install.js";

describe("Codex Windows shim", () => {
  it("only routes an argument-free invocation to Host", () => {
    expect(usesHostLaunch([])).toBe(true);
    expect(usesHostLaunch(["login"])).toBe(false);
    expect(usesHostLaunch(["exec", "echo hi"])).toBe(false);
    expect(usesHostLaunch(["--help"])).toBe(false);
  });

  it("keeps a runtime path with spaces quoted and forwards original arguments", () => {
    const script = renderCodexShim("C:\\Program Files\\Orbis Host\\runtime");
    expect(script).toContain('set "ORBIS_CODEX_RUNTIME=C:\\Program Files\\Orbis Host\\runtime"');
    expect(script).toContain('"%ORBIS_CODEX_RUNTIME%\\packages\\host\\dist\\codex-shim.js" %*');
  });
});
