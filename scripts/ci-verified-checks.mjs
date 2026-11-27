// CI-PERF-05: reuse completed CI gate runs for the exact commit SHA without weakening job coverage.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const CORE_BASE_JOBS = [
  "Lint, types and build (Ubuntu)",
  "Windows tests (1/4)",
  "Windows tests (2/4)",
  "Windows tests (3/4)",
  "Windows tests (4/4)",
];

const CORE_NATIVE_JOBS = [
  "Linux Relay compatibility and review integration tests",
  "macOS Host compatibility tests",
];

const IOS_JOBS = [
  "ios / tests",
  "ios / simulator",
];

function jobMatchesSuffix(jobName, suffix) {
  return jobName === suffix || jobName.endsWith(` / ${suffix}`);
}

export function hasVerifiedCheckJobs(runs, getJobs, { sha, mode = "core" }) {
  if (!/^[a-f0-9]{40}$/iu.test(sha ?? "")) return { verified: false, runId: null };
  const required = mode === "ios"
    ? IOS_JOBS
    : mode === "core-full"
      ? [...CORE_BASE_JOBS, ...CORE_NATIVE_JOBS]
      : CORE_BASE_JOBS;
  const allowedPaths = mode === "ios"
    ? new Set([".github/workflows/ci.yml", ".github/workflows/ios-build.yml"])
    : new Set([".github/workflows/ci.yml"]);

  for (const run of Array.isArray(runs) ? runs : []) {
    if (
      !run ||
      typeof run.id !== "number" ||
      run.head_sha !== sha ||
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      !allowedPaths.has(run.path)
    ) {
      continue;
    }
    const jobs = getJobs(run.id);
    if (!Array.isArray(jobs)) continue;
    const allPassed = required.every(suffix =>
      jobs.some(job =>
        job &&
        typeof job.name === "string" &&
        jobMatchesSuffix(job.name, suffix) &&
        job.status === "completed" &&
        job.conclusion === "success",
      ),
    );
    if (allPassed) return { verified: true, runId: run.id };
  }
  return { verified: false, runId: null };
}

function ghJson(args) {
  const output = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(output);
}

function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      sha: { type: "string" },
      mode: { type: "string", default: "core" },
    },
  });
  if (!values.repo || !values.sha || !["core", "core-full", "ios"].includes(values.mode)) {
    throw new Error("Usage: node scripts/ci-verified-checks.mjs --repo owner/name --sha <40-hex> [--mode core|core-full|ios]");
  }
  const runsPayload = ghJson(["api", `repos/${values.repo}/actions/runs?head_sha=${values.sha}&status=completed&per_page=50`]);
  const result = hasVerifiedCheckJobs(
    runsPayload.workflow_runs ?? [],
    runId => ghJson(["api", `repos/${values.repo}/actions/runs/${runId}/jobs?per_page=100`]).jobs ?? [],
    { sha: values.sha, mode: values.mode },
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
