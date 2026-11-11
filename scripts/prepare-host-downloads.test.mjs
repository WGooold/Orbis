import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const python = process.platform === "win32" ? "python" : "python3";
const script = fileURLToPath(new URL("../deploy/prepare-host-downloads.py", import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const name = (version, platform) => `OrbisHost-${version}-${platform === "windows" ? "windows-x64.zip" : "macos-arm64.dmg"}`;
const checksum = (file, body) => `${createHash("sha256").update(body).digest("hex")}  ${file}\r\n`;

function fixture(platform) {
  const root = mkdtempSync(join(tmpdir(), "orbis-host-downloads-")); roots.push(root);
  const previous = join(root, "previous"); mkdirSync(previous);
  for (const p of ["windows", "macos"]) {
    const file = name("0.1.17", p); const body = `previous ${p}`;
    writeFileSync(join(previous, file), body); writeFileSync(join(previous, `${file}.sha256`), checksum(file, body));
  }
  const file = name("0.1.18", platform); const body = `new ${platform}`;
  const archive = join(root, "incoming.tar.gz");
  execFileSync(python, ["-c", `
import io, json, sys, tarfile
with tarfile.open(sys.argv[1], "w:gz") as target:
    for name, text in json.load(sys.stdin).items():
        body = text.encode()
        entry = tarfile.TarInfo(name)
        entry.size = len(body)
        target.addfile(entry, io.BytesIO(body))
`, archive],
    { input: JSON.stringify({ [file]: body, [`${file}.sha256`]: checksum(file, body) }) });
  return { root, previous, archive, file, body, parent: join(root, "releases") };
}
const run = f => spawnSync(python, [script, "--archive", f.archive, "--previous", f.previous, "--parent", f.parent, "--release", "abc123"], { encoding: "utf8" });

// A Windows-first rollout must retain the last Mac download while removing the
// replaced Windows version; retries must not modify either serving directory.
it("publishes Windows alone without removing Mac downloads, including on retry", () => {
  const f = fixture("windows"); const first = run(f); expect(first.status).toBe(0);
  const firstDir = first.stdout.trim();
  expect(readdirSync(firstDir).sort()).toEqual([f.file, `${f.file}.sha256`, name("0.1.17", "macos"), `${name("0.1.17", "macos")}.sha256`].sort());
  expect(readFileSync(join(firstDir, f.file), "utf8")).toBe(f.body);
  const second = run({ ...f, previous: firstDir }); expect(second.status).toBe(0);
  expect(second.stdout.trim()).not.toBe(firstDir);
  expect(readdirSync(second.stdout.trim()).sort()).toEqual(readdirSync(firstDir).sort());
  expect(readFileSync(join(f.previous, name("0.1.17", "windows")), "utf8")).toBe("previous windows");
});

// The reverse staged rollout must preserve Windows when a later Mac package is ready.
it("publishes Mac alone while preserving the existing Windows payload", () => {
  const f = fixture("macos"); const result = run(f); expect(result.status).toBe(0);
  expect(readdirSync(result.stdout.trim()).sort()).toEqual([f.file, `${f.file}.sha256`, name("0.1.17", "windows"), `${name("0.1.17", "windows")}.sha256`].sort());
});

// Retention is not a checksum bypass: a corrupt unselected platform aborts before cutover.
it("rejects a corrupt retained package and removes only its new staging directory", () => {
  const f = fixture("windows"); writeFileSync(join(f.previous, name("0.1.17", "macos")), "corrupted");
  const result = run(f); expect(result.status).not.toBe(0); expect(result.stderr).toContain("Host SHA-256 mismatch");
  expect(readdirSync(f.parent)).toEqual([]);
  expect(readFileSync(join(f.previous, name("0.1.17", "macos")), "utf8")).toBe("corrupted");
});
