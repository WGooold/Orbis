import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agySubmissionFence } from "./agy-submission-fence.js";

// AGY-12: no text, credentials or native IDs are stored in delivery markers;
// another incarnation must not issue the same prompt after an ambiguous exit.
it("admits one submit even across fence incarnations and scopes it to the native session", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-delivery-"));
  try {
    const a = agySubmissionFence(root), b = agySubmissionFence(root);
    expect((await Promise.all([a("native-a", "mobile-id"), b("native-a", "mobile-id")])).sort()).toEqual([false, true]);
    expect(await agySubmissionFence(root)("native-a", "mobile-id")).toBe(false);
    expect(await b("native-b", "mobile-id")).toBe(true);
    expect(await readdir(join(root, "agy-acp", "submitted"))).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u), expect.stringMatching(/^[a-f0-9]{64}$/u)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
