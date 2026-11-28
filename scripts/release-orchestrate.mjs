// CI-PERF-05: single-command release orchestrator preserving workflow run-path provenance.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const PLATFORM_WORKFLOWS = {
  windows: "windows-host-build.yml",
  macos: "macos-host-build.yml",
  linux: "linux-host-build.yml",
  android: "android-build.yml",
};

export function buildReleasePlan(options) {
  const { tag, sha, platforms = ["windows", "macos", "linux"], deployRelay = true, androidReleaseTag, androidApkSha256 } = options;
  if (!/^v\d+\.\d+\.\d+$/u.test(tag ?? "")) throw new Error("Expected --tag vX.Y.Z");
  if (!/^[a-f0-9]{40}$/iu.test(sha ?? "")) throw new Error("Expected 40-char --sha");
  const selected = [...new Set(platforms)];
  if (!selected.length || selected.some(item => !(item in PLATFORM_WORKFLOWS))) {
    throw new Error("Select at least one valid platform: windows, macos, linux, android");
  }
  if (Boolean(androidReleaseTag) !== Boolean(androidApkSha256)) {
    throw new Error("Pass both --android-release-tag and --android-apk-sha256 together");
  }
  return {
    tag,
    sha,
    buildWorkflows: selected.map(platform => ({ platform, workflow: PLATFORM_WORKFLOWS[platform] })),
    publishRelease: true,
    deployRelay,
    androidReleaseTag: androidReleaseTag ?? null,
    androidApkSha256: androidApkSha256 ?? null,
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

async function waitForDispatchedRun(repo, workflow, sha, startedAfterMs) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const payload = JSON.parse(gh(["api", `repos/${repo}/actions/runs?event=workflow_dispatch&head_sha=${sha}&per_page=30`]));
    const match = (payload.workflow_runs ?? []).find(run =>
      run.path === `.github/workflows/${workflow}` &&
      Date.parse(run.created_at) >= startedAfterMs - 5000,
    );
    if (match) return match.id;
    await delay(3000);
  }
  throw new Error(`Timed out locating dispatched run for ${workflow} on ${sha}`);
}

async function waitForCompletion(repo, runId, label) {
  for (;;) {
    const run = JSON.parse(gh(["api", `repos/${repo}/actions/runs/${runId}`]));
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`${label} (${runId}) concluded with ${run.conclusion}: ${run.html_url}`);
      }
      return run;
    }
    await delay(15000);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: "WGooold/Orbis" },
      tag: { type: "string" },
      sha: { type: "string" },
      platforms: { type: "string", default: "windows,macos,linux" },
      "no-relay-deploy": { type: "boolean", default: false },
      "android-release-tag": { type: "string" },
      "android-apk-sha256": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const sha = values.sha ?? gh(["rev-parse", `refs/tags/${values.tag}^{commit}`]);
  const plan = buildReleasePlan({
    tag: values.tag,
    sha,
    platforms: values.platforms.split(",").map(item => item.trim()).filter(Boolean),
    deployRelay: !values["no-relay-deploy"],
    androidReleaseTag: values["android-release-tag"],
    androidApkSha256: values["android-apk-sha256"],
  });
  if (values["dry-run"]) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const runIds = {};
  const dispatchedAt = Date.now();
  for (const { platform, workflow } of plan.buildWorkflows) {
    gh(["workflow", "run", workflow, "--repo", values.repo, "--ref", "main"]);
    runIds[platform] = await waitForDispatchedRun(values.repo, workflow, plan.sha, dispatchedAt);
    console.log(`Dispatched ${workflow}: run ${runIds[platform]}`);
  }
  await Promise.all(
    plan.buildWorkflows.map(({ platform, workflow }) => waitForCompletion(values.repo, runIds[platform], workflow)),
  );

  const releaseArgs = ["workflow", "run", "client-release.yml", "--repo", values.repo, "--ref", "main", "-f", `release_tag=${plan.tag}`];
  if (runIds.windows) releaseArgs.push("-f", `windows_build_run_id=${runIds.windows}`);
  if (runIds.macos) releaseArgs.push("-f", `macos_build_run_id=${runIds.macos}`);
  if (runIds.linux) releaseArgs.push("-f", `linux_build_run_id=${runIds.linux}`);
  if (runIds.android) releaseArgs.push("-f", `android_build_run_id=${runIds.android}`);
  const publishAt = Date.now();
  gh(releaseArgs);
  const publishRunId = await waitForDispatchedRun(values.repo, "client-release.yml", plan.sha, publishAt);
  await waitForCompletion(values.repo, publishRunId, "client-release.yml");
  console.log(`Published release ${plan.tag} via run ${publishRunId}`);

  if (plan.deployRelay) {
    const deployArgs = ["workflow", "run", "relay-deploy.yml", "--repo", values.repo, "--ref", "main"];
    if (runIds.windows) deployArgs.push("-f", `windows_build_run_id=${runIds.windows}`);
    if (runIds.macos) deployArgs.push("-f", `macos_build_run_id=${runIds.macos}`);
    if (runIds.linux) deployArgs.push("-f", `linux_build_run_id=${runIds.linux}`);
    if (plan.androidReleaseTag) {
      deployArgs.push("-f", `android_release_tag=${plan.androidReleaseTag}`, "-f", `android_apk_sha256=${plan.androidApkSha256}`);
    }
    const deployAt = Date.now();
    gh(deployArgs);
    const deployRunId = await waitForDispatchedRun(values.repo, "relay-deploy.yml", plan.sha, deployAt);
    await waitForCompletion(values.repo, deployRunId, "relay-deploy.yml");
    console.log(`Deployed Relay and website downloads via run ${deployRunId}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
