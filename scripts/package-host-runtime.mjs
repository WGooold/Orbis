import { access, cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? ".artifacts/windows-host/OrbisHost/runtime");
if (!output.startsWith(resolve(root, ".artifacts") + sep)) throw new Error("Runtime output must be inside this worktree's .artifacts directory");
await mkdir(output, { recursive: true });
await writeFile(join(output, "package.json"), JSON.stringify({ name: "orbis-host-runtime", private: true, type: "module", version: "0.1.0" }, null, 2));
await cp(join(root, "LICENSE"), join(output, "LICENSE"));
await cp(join(root, "THIRD-PARTY-NOTICES.md"), join(output, "THIRD-PARTY-NOTICES.md"));
const copied = new Set();
const inventory = [];

async function locate(name, from) {
  let current = from;
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    try { await access(join(candidate, "package.json")); return candidate; } catch { /* continue searching */ }
    const parent = dirname(current); if (parent === current) return undefined; current = parent;
  }
}

async function bundle(source, target) {
  if (copied.has(target)) return;
  copied.add(target);
  const actual = await realpath(source);
  const manifest = JSON.parse(await readFile(join(actual, "package.json"), "utf8"));
  await mkdir(target, { recursive: true });
  const workspace = actual.startsWith(join(root, "packages") + sep);
  if (workspace) {
    await cp(join(actual, "dist"), join(target, "dist"), { recursive: true });
    await cp(join(actual, "package.json"), join(target, "package.json"));
    await cp(join(root, "LICENSE"), join(target, "LICENSE"));
  } else {
    await cp(actual, target, { recursive: true, dereference: true, filter: sourcePath => !relative(actual, sourcePath).split(sep).includes("node_modules") });
  }
  inventory.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? "See package source", path: relative(output, target).replaceAll("\\", "/") });
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  for (const name of Object.keys(dependencies)) {
    const dependency = await locate(name, actual);
    if (!dependency) {
      if (manifest.optionalDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional) continue;
      throw new Error(`Missing runtime dependency ${name} required by ${manifest.name}`);
    }
    const rel = relative(join(root, "node_modules"), dependency);
    if (rel.startsWith("..")) throw new Error(`Dependency outside repository node_modules: ${name}`);
    await bundle(dependency, join(output, "node_modules", rel));
  }
}

for (const name of ["host", "pi-extension"]) await bundle(join(root, "packages", name), join(output, "packages", name));
const nodeRoot = dirname(process.execPath);
await mkdir(join(output, "node", "node_modules"), { recursive: true });
await cp(process.execPath, join(output, "node", "node.exe"));
await cp(join(nodeRoot, "node_modules", "npm"), join(output, "node", "node_modules", "npm"), { recursive: true, dereference: true });
// npm lifecycle scripts may invoke npm/npx themselves; keep those launchers next to the pinned Node.
for (const launcher of ["npm.cmd", "npx.cmd", "npm", "npx"]) {
  try { await access(join(nodeRoot, launcher)); } catch { continue; }
  await cp(join(nodeRoot, launcher), join(output, "node", launcher));
}
for (const file of await readdir(nodeRoot)) if (/^(LICENSE|LICENSE\.txt)$/i.test(file)) await cp(join(nodeRoot, file), join(output, "node", file));
await writeFile(join(output, "DEPENDENCIES.json"), JSON.stringify({ node: process.version, packages: inventory }, null, 2));
console.log(`Packaged Node ${process.version} and ${inventory.length} runtime packages into ${output}`);
