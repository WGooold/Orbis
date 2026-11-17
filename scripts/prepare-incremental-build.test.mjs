import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareIncrementalBuild } from "./prepare-incremental-build.mjs";

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbis-incremental-")); roots.push(root);
  const project = join(root, "packages", "example");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "dist"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ references: [{ path: "packages/example" }] }));
  await writeFile(join(project, "src", "index.ts"), "export const value = 1;");
  await writeFile(join(project, "tsconfig.tsbuildinfo"), JSON.stringify({ fileNames: ["./src/index.ts"] }));
  for (const extension of [".js", ".js.map", ".d.ts", ".d.ts.map"]) await writeFile(join(project, "dist", "index" + extension), "output");
  return { root, project };
}
// A warm build retains its cache, but missing bytes must force a real rebuild.
it("keeps complete unchanged build outputs", async () => {
  const { root, project } = await fixture();
  await prepareIncrementalBuild(root);
  expect(await readFile(join(project, "dist", "index.js"), "utf8")).toBe("output");
  await expect(readFile(join(project, "tsconfig.tsbuildinfo"))).resolves.toBeDefined();
});
it("invalidates a project if an emitted file is missing", async () => {
  const { root, project } = await fixture();
  await rm(join(project, "dist", "index.js"));
  await prepareIncrementalBuild(root);
  await expect(readFile(join(project, "tsconfig.tsbuildinfo"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("removes old emitted modules when a source is deleted", async () => {
  const { root, project } = await fixture();
  await rm(join(project, "src", "index.ts"));
  await prepareIncrementalBuild(root);
  await expect(readFile(join(project, "dist", "index.js"))).rejects.toMatchObject({ code: "ENOENT" });
});
