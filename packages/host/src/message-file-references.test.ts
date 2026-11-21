import { mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MessageFileReferences } from "./message-file-references.js";

// MSG-RENDER-01 / FILE-PREVIEW-03: a citation cannot change owners or escape a relative workspace; a rewritten
// file is opened as it is now, and only a single read is bound to the identity it started with.
it("binds reference actions to a paired device and opens a rewritten file as it is now", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbis-message-file-"));
  try {
    const dir = await realpath(root);
    const file = join(dir, "答复 1.md");
    await writeFile(file, "first");
    const refs = new MessageFileReferences();
    const ref = refs.register("答复 1.md", dir, "phone", "session")!;
    expect(refs.register("./答复 1.md", dir, "phone", "session")).toEqual(ref);
    expect(refs.register("../outside.md", dir, "phone", "session")).toBeUndefined();
    await expect(refs.resolve(ref.referenceId, "other")).rejects.toThrow("message_file_unavailable");
    await expect(refs.resolve(ref.referenceId, "phone")).resolves.toBe(file);
    const first = await refs.resolveIdentity(ref.referenceId, "phone");
    await rename(file, join(dir, "first.md"));
    await writeFile(file, "second");
    const second = await refs.resolveIdentity(ref.referenceId, "phone");
    expect(second.path).toBe(file);
    expect(second.identity).not.toBe(first.identity);
    expect(refs.register("答复 1.md", dir, "phone", "session")).toEqual(ref);
    await expect(refs.resolve(ref.referenceId, "phone")).resolves.toBe(file);
    if (process.platform !== "win32") {
      await symlink(process.execPath, join(dir, "outside"));
      const link = refs.register("outside", dir, "phone", "session")!;
      await expect(refs.resolve(link.referenceId, "phone")).rejects.toThrow("message_file_unavailable");
    }
    refs.releaseDevice("phone");
    await expect(refs.resolve(ref.referenceId, "phone")).rejects.toThrow("message_file_unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
