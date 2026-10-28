import { describe, expect, it } from "vitest";

import { appBundleOf, bundledCodexCli, codexDesktopExecutableOf, renderCodexDesktopEntryAgent, resolveMacCodexDesktopExecutable } from "./codex-desktop-macos.js";

describe("Codex desktop on macOS", () => {
  it("maps a main executable back to its app bundle and bundled CLI", () => {
    expect(appBundleOf("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")).toBe("/Applications/ChatGPT.app");
    expect(appBundleOf("/opt/homebrew/bin/node")).toBeUndefined();
    expect(bundledCodexCli("/Applications/ChatGPT.app")).toBe("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  });

  it("escapes the entry value in the login agent", () => {
    const plist = renderCodexDesktopEntryAgent("CODEX_CLI_PATH", "/Users/a&b/<x>/codex-launcher");
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;x&gt;/codex-launcher</string>");
    expect(plist).toContain("<string>setenv</string>");
  });

  // 同名的 ChatGPT.app 也可能是普通 ChatGPT（com.openai.chat）：只能按 bundle id 认。
  it.runIf(process.platform === "darwin")("only accepts the Codex bundle identifier", async () => {
    await expect(codexDesktopExecutableOf("/System/Applications/Calculator.app")).resolves.toBeUndefined();
    await expect(resolveMacCodexDesktopExecutable(["/System/Applications/Calculator.app"])).resolves.not.toBe("/System/Applications/Calculator.app/Contents/MacOS/Calculator");
  });
});
