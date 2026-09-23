import { readdir, rm } from "node:fs/promises";
import { URL } from "node:url";

for (const entry of await readdir(new URL("../packages/", import.meta.url), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  await rm(new URL(`../packages/${entry.name}/dist/`, import.meta.url), { recursive: true, force: true });
  await rm(new URL(`../packages/${entry.name}/tsconfig.tsbuildinfo`, import.meta.url), { force: true });
}
