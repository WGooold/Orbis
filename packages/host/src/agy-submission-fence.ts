import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

/** ACP prompt has no persistent client message ID. A spent marker prevents
 * retransmission after restart, but is never itself proof of delivery. */
export type AgySubmissionFence = (sessionId: string, messageId: string) => Promise<boolean>;
export function agySubmissionFence(stateDir: string): AgySubmissionFence {
  let directory: Promise<string> | undefined;
  return async (sessionId, messageId) => {
    const root = await (directory ??= Promise.resolve().then(async () => {
      const path = join(stateDir, "agy-acp", "submitted");
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    }).catch(error => { directory = undefined; throw error; }));
    const name = createHash("sha256").update(JSON.stringify([sessionId, messageId])).digest("hex");
    try {
      const file = await open(join(root, name), "wx", 0o600);
      try { await file.sync(); } finally { await file.close(); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };
}
