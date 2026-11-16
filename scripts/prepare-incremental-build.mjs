import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// CI-PERF-03: incremental builds must still recover deleted outputs and sources.
export async function prepareIncrementalBuild(root) {
  const configuration = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  await Promise.all(configuration.references.map(async reference => {
    const project = resolve(root, reference.path);
    const stamp = join(project, "tsconfig.tsbuildinfo");
    let info;
    try { info = JSON.parse(await readFile(stamp, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const sources = info.fileNames.filter(name => /^(?:\.\/)?src\/.*\.ts$/u.test(name) && !name.endsWith(".d.ts"));
    const missing = await Promise.all(sources.map(async name => {
      const relative = name.replace(/^(?:\.\/)?src\//u, "").replace(/\.ts$/u, "");
      const files = [join(project, name), ...[".js", ".js.map", ".d.ts", ".d.ts.map"].map(extension => join(project, "dist", relative + extension))];
      try { await Promise.all(files.map(file => access(file))); return false; }
      catch (error) { if (error.code === "ENOENT") return true; throw error; }
    }));
    if (missing.some(Boolean)) {
      await rm(join(project, "dist"), { recursive: true, force: true });
      await rm(stamp, { force: true });
    }
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareIncrementalBuild(fileURLToPath(new URL("../", import.meta.url)));
}
