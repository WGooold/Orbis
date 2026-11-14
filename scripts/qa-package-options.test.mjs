import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseQaActivation } from "../packages/protocol/src/qa-activation.ts";
import { parseQaPackageOptions, loadPackageQaActivation, stageQaActivation } from "./qa-package-options.mjs";

describe("QA-ACT-01 packaging input and release cleanup", () => {
  const directories = [];
  afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
  it("keeps the private value out of argv and removes stale activation on release repackaging", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbis-qa-package-")); directories.push(root);
    const activation = { version: 1, environmentId: "qa-test", relayUrl: "wss://qa.example.test:18443", credential: "qa-package-fixture-secret-only" };
    const source = join(root, "private.json"); await writeFile(source, JSON.stringify(activation));
    expect(parseQaPackageOptions([root, "--qa-activation-file", source])).toEqual({ output: root, activationFile: source });
    const parsed = await loadPackageQaActivation(source, parseQaActivation);
    await stageQaActivation(root, parsed);
    expect(JSON.parse(await readFile(join(root, "qa-activation.json"), "utf8"))).toEqual(activation);
    if (process.platform !== "win32") expect((await stat(join(root, "qa-activation.json"))).mode & 0o777).toBe(0o600);
    await stageQaActivation(root, undefined);
    await expect(stat(join(root, "qa-activation.json"))).rejects.toHaveProperty("code", "ENOENT");
  });
  it("rejects incomplete or ambiguous arguments and private JSON without dumping its value", async () => {
    expect(() => parseQaPackageOptions(["--qa-activation-file"])).toThrow("Supply one");
    expect(() => parseQaPackageOptions(["out", "--qa-activation-file", "a", "--qa-activation-file", "b"])).toThrow("Supply one");
    const root = await mkdtemp(join(tmpdir(), "orbis-qa-package-invalid-")); directories.push(root);
    const source = join(root, "bad.json"); await writeFile(source, '{"credential":"do-not-echo');
    await expect(loadPackageQaActivation(source, parseQaActivation)).rejects.toThrow(/^Cannot read valid QA activation JSON$/);
    expect(() => parseQaActivation({ version: 1, environmentId: "../formal", credential: "fixture-token-12345", relayUrl: "wss://qa.example.test" })).toThrow("environmentId");
  });
});
