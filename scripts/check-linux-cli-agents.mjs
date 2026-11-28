// LINUX-HOST-VERIFY-06: fail when a new wire AgentKind has no Linux CLI test lane.
// These are fixture-driven regressions, not live provider/model or handset acceptance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { AgentKindSchema } from "../packages/protocol/dist/index.js";
import { linuxCliEligible } from "../packages/host/dist/cli-profile.js";

assert.equal(process.platform, "linux", "Run the CLI release gate on Linux");
const lanes = {
  pi: ["spawner", "agent-backend"],
  codex: ["codex-daemon", "codex-runtime", "codex-approval-lifecycle"],
  dsh: ["dsh-runtime", "dsh-runtime-recovery"],
  hermes: ["hermes-agent-backend", "hermes-host-connection"],
  kimiCode: ["kimi-web-client", "kimi-conversation", "kimi-input", "kimi-interactions"],
  openclaw: ["openclaw-backend", "openclaw-local-launch"],
  opencode: ["opencode-backend", "opencode-service-connection"],
  agy: ["agy-runtime", "agy-client"],
  claude: null, // requires a desktop terminal in the current Host
  codexDesktop: null,
  dshDesktop: null,
  kimiCodeDesktop: null,
};
assert.deepEqual(Object.keys(lanes).sort(), [...AgentKindSchema.options].sort());
for (const [kind, suites] of Object.entries(lanes)) assert.equal(Boolean(suites?.length), linuxCliEligible[kind], kind);

const evidence = ".artifacts/linux-cli-verification";
mkdirSync(evidence, { recursive: true });
writeFileSync(`${evidence}/agent-lanes.json`, `${JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  mode: "synthetic",
  lanes,
}, null, 2)}\n`);
const vitest = (suites, report, ...args) => {
  const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run",
    ...suites.map(suite => `packages/host/src/${suite}.test.ts`), "--maxWorkers=2", "--testTimeout=20000",
    "--reporter=default", "--reporter=junit", `--outputFile.junit=${evidence}/${report}.xml`, ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${report} failed${result.signal ? ` (${result.signal})` : ""}`);
};
vitest(["cli-profile", "cli-pair", "agent-enablement", ...new Set(Object.values(lanes).flatMap(suites => suites ?? []))], "adapter-regressions");
vitest(["host-service"], "encrypted-host-regressions", "-t",
  "starts OpenClaw only|gates OpenCode by device feature|negotiates Antigravity|runs Kimi Web and Desktop together|reopens a quit DSH|advertises automatic session spawn|session.activate 走注入的 spawner");
