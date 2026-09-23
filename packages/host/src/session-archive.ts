import { link, lstat, mkdir, unlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { defaultPiSessionsRoot, listPiSessions } from "./sessions.js";

export class SessionArchiveError extends Error {
  constructor(readonly code: "session_busy" | "session_not_found" | "session_conflict", message: string) {
    super(message);
  }
}

/** Outside Pi's scan root; keep the original group and filename so restore needs no sidecar. */
export function piArchiveRoot(root = defaultPiSessionsRoot()): string {
  return join(dirname(root), `${basename(root)}-archived`);
}

/** Never replace another file. A crash between link/unlink leaves two links to the same history. */
async function moveWithoutReplacement(source: string, destination: string, assertIdle: () => void): Promise<void> {
  const sourceInfo = await lstat(source, { bigint: true });
  if (!sourceInfo.isFile()) throw new SessionArchiveError("session_conflict", "会话文件不是普通文件");
  await mkdir(dirname(destination), { recursive: true });
  assertIdle();
  try {
    await link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const targetInfo = await lstat(destination, { bigint: true });
    if (targetInfo.dev !== sourceInfo.dev || targetInfo.ino !== sourceInfo.ino) {
      throw new SessionArchiveError("session_conflict", "目标路径已有另一个文件，未覆盖任何会话");
    }
  }
  // If removal fails, keep both links. A retry can finish the move without losing either file.
  await unlink(source);
}

export async function setPiSessionArchived(
  sessionId: string,
  archived: boolean,
  options: { root?: string; assertIdle: () => void },
): Promise<void> {
  const root = options.root ?? defaultPiSessionsRoot();
  const archiveRoot = piArchiveRoot(root);
  const fromRoot = archived ? root : archiveRoot;
  const toRoot = archived ? archiveRoot : root;
  const [source, target] = await Promise.all([listPiSessions({ root: fromRoot }), listPiSessions({ root: toRoot })]);
  const sourceFile = source.files.get(sessionId);
  const targetFile = target.files.get(sessionId);
  if (sourceFile === undefined) {
    if (targetFile !== undefined) return; // Desired state already reached (e.g. lost response).
    throw new SessionArchiveError("session_not_found", "找不到这个 Pi 会话");
  }
  const destination = join(toRoot, relative(fromRoot, sourceFile));
  if (targetFile !== undefined && targetFile !== destination) {
    throw new SessionArchiveError("session_conflict", "目标目录已有同 ID 的另一个会话，未移动文件");
  }
  await moveWithoutReplacement(sourceFile, destination, options.assertIdle);
}
