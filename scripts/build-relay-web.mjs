import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function mirrorWebAssets(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map(entry => entry.name));
  for (const name of await readdir(target)) {
    if (!names.has(name)) await rm(join(target, name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const from = join(source, entry.name), to = join(target, entry.name);
    if (entry.isDirectory()) await mirrorWebAssets(from, to);
    else {
      const existing = await readFile(to).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!existing || !existing.equals(await readFile(from))) await cp(from, to);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await mirrorWebAssets(fileURLToPath(new URL("../packages/relay/src/web/", import.meta.url)), fileURLToPath(new URL("../packages/relay/dist/web/", import.meta.url)));
}
