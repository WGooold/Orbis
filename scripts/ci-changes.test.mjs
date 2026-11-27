import { describe, expect, it } from "vitest";
import { classifyChanges } from "./ci-changes.mjs";

// A required gate must pass for documentation, while mixed changes retain all checks.
describe("CI change selection", () => {
  it("skips expensive jobs for documentation anywhere in the repository", () => {
    expect(classifyChanges(["README.md", "docs/adr/example.md", "docs/images/example.png", "ios/README.md", "packages/host/README.md"]))
      .toEqual({ core: false, ios: false, hostNative: false, relay: false });
  });
  it("keeps shared protocol and iOS fixture changes covered", () => {
    expect(classifyChanges(["README.md", "shared/math-tests/fixture.json"]))
      .toEqual({ core: true, ios: true, hostNative: false, relay: false });
    expect(classifyChanges(["ios/Orbis/Orbis/Models.swift"]).ios).toBe(true);
  });
  it("gates native Qt/QML Host changes without redeploying Relay", () => {
    expect(classifyChanges(["packages/windows-host/src/HostController.cpp"]))
      .toEqual({ core: true, ios: false, hostNative: true, relay: false });
    expect(classifyChanges(["scripts/windows/windows-host-build.ps1"]))
      .toEqual({ core: true, ios: false, hostNative: true, relay: false });
  });
  it("covers the complete Docker workspace dependency graph and its configuration", () => {
    for (const path of ["packages/e2e/src/index.ts", "packages/runtime-bridge/src/index.ts", "package-lock.json", ".dockerignore", "scripts/build-relay-web.mjs"]) {
      expect(classifyChanges([path])).toEqual({ core: true, ios: false, hostNative: false, relay: true });
    }
  });
  it("runs all relevant checks when CI itself changes", () => {
    expect(classifyChanges([".github/workflows/ci-pipeline.yml"]))
      .toEqual({ core: true, ios: true, hostNative: true, relay: true });
    expect(classifyChanges([".github/workflows/core-checks.yml"]))
      .toEqual({ core: true, ios: true, hostNative: false, relay: true });
  });
  it("does not hide code removal when a file is renamed into documentation", () => {
    expect(classifyChanges([{ filename: "docs/removed.md", previous_filename: "packages/relay/src/index.ts" }]))
      .toEqual({ core: true, ios: false, hostNative: false, relay: true });
  });
});
