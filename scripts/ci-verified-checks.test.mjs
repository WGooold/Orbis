import { describe, expect, it } from "vitest";
import { hasVerifiedCheckJobs } from "./ci-verified-checks.mjs";
import { buildReleasePlan } from "./release-orchestrate.mjs";

const SHA = "ce0acf7fe710f36a1ad76eab15d6eff176c27a6f";

function makeJobs(names, overrides = {}) {
  return names.map(name => ({
    name,
    status: "completed",
    conclusion: overrides[name] ?? "success",
  }));
}

const FULL_CORE_JOBS = [
  "main / checks / Lint, types and build (Ubuntu)",
  "main / checks / Windows tests (1/4)",
  "main / checks / Windows tests (2/4)",
  "main / checks / Windows tests (3/4)",
  "main / checks / Windows tests (4/4)",
  "main / checks / Linux Relay compatibility and review integration tests",
  "main / checks / macOS Host compatibility tests",
];

// CI-PERF-05: a skipped or partial CI run must never bypass release or deploy gates.
describe("verified CI check reuse", () => {
  it("accepts an exact-SHA CI run only when every required job succeeded", () => {
    const runs = [{ id: 101, head_sha: SHA, status: "completed", conclusion: "success", path: ".github/workflows/ci.yml" }];
    expect(hasVerifiedCheckJobs(runs, () => makeJobs(FULL_CORE_JOBS), { sha: SHA, mode: "core-full" }))
      .toEqual({ verified: true, runId: 101 });
  });

  it("refuses documentation-only or partial CI runs where native compatibility was skipped", () => {
    const runs = [{ id: 102, head_sha: SHA, status: "completed", conclusion: "success", path: ".github/workflows/ci.yml" }];
    const baseOnly = makeJobs(FULL_CORE_JOBS, {
      "main / checks / Linux Relay compatibility and review integration tests": "skipped",
      "main / checks / macOS Host compatibility tests": "skipped",
    });
    expect(hasVerifiedCheckJobs(runs, () => baseOnly, { sha: SHA, mode: "core" }))
      .toEqual({ verified: true, runId: 102 });
    expect(hasVerifiedCheckJobs(runs, () => baseOnly, { sha: SHA, mode: "core-full" }))
      .toEqual({ verified: false, runId: null });
  });

  it("refuses mismatched SHA, failed runs, or non-CI workflows", () => {
    const runs = [
      { id: 1, head_sha: "0".repeat(40), status: "completed", conclusion: "success", path: ".github/workflows/ci.yml" },
      { id: 2, head_sha: SHA, status: "completed", conclusion: "failure", path: ".github/workflows/ci.yml" },
      { id: 3, head_sha: SHA, status: "completed", conclusion: "success", path: ".github/workflows/review-host.yml" },
    ];
    expect(hasVerifiedCheckJobs(runs, () => makeJobs(FULL_CORE_JOBS), { sha: SHA, mode: "core" }))
      .toEqual({ verified: false, runId: null });
  });

  it("verifies both iOS test and simulator jobs before skipping TestFlight pre-checks", () => {
    const runs = [{ id: 205, head_sha: SHA, status: "completed", conclusion: "success", path: ".github/workflows/ci.yml" }];
    expect(hasVerifiedCheckJobs(runs, () => makeJobs(["main / ios / tests", "main / ios / simulator"]), { sha: SHA, mode: "ios" }))
      .toEqual({ verified: true, runId: 205 });
    expect(hasVerifiedCheckJobs(runs, () => makeJobs(["main / ios / tests"]), { sha: SHA, mode: "ios" }))
      .toEqual({ verified: false, runId: null });
  });
});

describe("release orchestrator plan validation", () => {
  it("preserves exact workflow paths and requires paired Android release inputs", () => {
    const plan = buildReleasePlan({ tag: "v0.1.25", sha: SHA, platforms: ["windows", "macos", "windows"] });
    expect(plan.buildWorkflows).toEqual([
      { platform: "windows", workflow: "windows-host-build.yml" },
      { platform: "macos", workflow: "macos-host-build.yml" },
    ]);
    expect(() => buildReleasePlan({ tag: "v0.1.25", sha: SHA, androidReleaseTag: "android-v0.1.61" }))
      .toThrow(/together/u);
  });
});
