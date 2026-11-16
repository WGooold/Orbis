import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mirrorWebAssets } from "./build-relay-web.mjs";

// CI-PERF-03: a warm build preserves bytes and timestamps; deleted assets cannot ship.
it("copies changed assets, removes stale ones and retains untouched timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbis-web-build-"));
  const source = join(root, "source"), target = join(root, "target");
  try {
    await mkdir(source); await mkdir(target);
    await writeFile(join(source, "style.css"), "new style");
    await writeFile(join(target, "style.css"), "old style");
    await writeFile(join(source, "logo.svg"), "same logo");
    await writeFile(join(target, "logo.svg"), "same logo");
    await writeFile(join(target, "deleted.js"), "stale");
    const previous = new Date("2000-01-01T00:00:00Z");
    await utimes(join(target, "logo.svg"), previous, previous);
    await mirrorWebAssets(source, target);
    expect(await readFile(join(target, "style.css"), "utf8")).toBe("new style");
    expect((await stat(join(target, "logo.svg"))).mtimeMs).toBe(previous.getTime());
    await expect(readFile(join(target, "deleted.js"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
