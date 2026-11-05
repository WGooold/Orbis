import { execFileSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? ".artifacts/quic-review/host-native");
if (!output.startsWith(resolve(root, ".artifacts") + sep)) throw new Error("QUIC helper output must be inside this worktree's .artifacts");
const go = process.env.ORBIS_GO ?? "go";
const platform = process.env.GOOS ?? ({ win32: "windows", darwin: "darwin", linux: "linux" })[process.platform];
const architecture = process.env.GOARCH ?? ({ x64: "amd64", arm64: "arm64" })[process.arch];
if (!platform || !architecture) throw new Error("Unsupported QUIC helper target");
const cwd = join(root, "native", "relayquic");
const env = { ...process.env, GOOS: platform, GOARCH: architecture, CGO_ENABLED: "0" };
const run = args => execFileSync(go, args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
await mkdir(join(output, "bin"), { recursive: true });
const binary = join(output, "bin", `orbis-quic-client${platform === "windows" ? ".exe" : ""}`);
run(["build", "-trimpath", "-buildvcs=false", "-o", binary, "./cmd/orbis-quic-client"]);
const dependencies = run(["list", "-deps", "-f", "{{if .Module}}{{.Module.Path}} {{.Module.Version}} {{.Module.Dir}}{{end}}", "./cmd/orbis-quic-client"])
  .split("\n").filter(Boolean);
const modules = new Map();
for (const row of dependencies) {
  const [name, version, ...parts] = row.split(" ");
  if (!version || !parts.length) continue; // this module is covered by the Orbis license
  modules.set(name, { name, version, directory: parts.join(" ") });
}
const inventory = [];
for (const item of modules.values()) {
  const target = join(output, "licenses", item.name.replaceAll("/", "_"));
  await mkdir(target, { recursive: true });
  // All modules used by the helper supply LICENSE. Fail packaging if it is absent.
  await cp(join(item.directory, "LICENSE"), join(target, "LICENSE"));
  inventory.push({ name: item.name, version: item.version, license: `licenses/${item.name.replaceAll("/", "_")}/LICENSE` });
}
const goroot = run(["env", "GOROOT"]).trim();
await mkdir(join(output, "licenses", "go"), { recursive: true });
await cp(join(goroot, "LICENSE"), join(output, "licenses", "go", "LICENSE"));
await cp(join(root, "LICENSE"), join(output, "LICENSE"));
await writeFile(join(output, "DEPENDENCIES.json"), JSON.stringify({ go: run(["version"]).trim(), platform, architecture, modules: inventory }, null, 2));
// Confirm the produced executable contains the expected module and target metadata.
const buildInfo = run(["version", "-m", binary]);
if (!buildInfo.includes("/cmd/orbis-quic-client") || !buildInfo.includes(`GOOS=${platform}`) || !buildInfo.includes(`GOARCH=${architecture}`)) throw new Error("QUIC helper build metadata mismatch");
await writeFile(join(output, "BUILD.txt"), buildInfo);
console.log(`Packaged native QUIC helper for ${platform}/${architecture}: ${binary}`);
