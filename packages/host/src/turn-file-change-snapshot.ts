import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type CapturedFile = { kind: "file" | "symlink" | "directory" | "other"; bytes: number; hash?: string; blob?: string; mode: number; unavailable?: boolean; contentUnavailable?: boolean };
export type WorkspaceSnapshot = { scope: "git-visible-files" | "bounded-directory" | "unknown"; root: string; files: Record<string, CapturedFile>; complete: boolean; reasons: string[]; capturedAt: number };
export type BlobStorageQuota = { used: number; maximum: number; hashes: Set<string> };
export type CaptureBudget = { maxEntries: number; maxBytes: number; maxFileBytes: number; maxMs: number };
export const DEFAULT_CAPTURE_BUDGET: CaptureBudget = { maxEntries: 20_000, maxBytes: 256 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxMs: 2_000 };
const excluded = new Set([".git", "node_modules", ".build", "DerivedData", ".gradle", ".next", ".cache", "__pycache__", "build", "dist", "target"]);
const sha = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const safeRelative = (path: string): boolean => path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]/u).some(part => part === ".." || part === "");
export const blobPath = (directory: string, hash: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("invalid_content_identity");
  return join(directory, "blobs", hash);
};
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
const blobWrites = new Map<string, Promise<boolean>>();
function putBlob(directory: string, hash: string, bytes: Buffer, quota?: BlobStorageQuota): Promise<boolean> {
  const path = blobPath(directory, hash), existing = blobWrites.get(path);
  if (existing) return existing;
  if (quota?.hashes.has(hash)) return Promise.resolve(true);
  if (quota && quota.used + bytes.length > quota.maximum) return Promise.resolve(false);
  if (quota) { quota.used += bytes.length; quota.hashes.add(hash); }
  const work = (async (): Promise<boolean> => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(directory, "blobs"), { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, path); // A crash exposes either a complete blob or no blob.
      return true;
    } catch (error) {
      if (quota) { quota.used -= bytes.length; quota.hashes.delete(hash); }
      throw error;
    } finally { await rm(temporary, { force: true }); }
  })();
  blobWrites.set(path, work);
  void work.finally(() => { if (blobWrites.get(path) === work) blobWrites.delete(path); }).catch(() => undefined);
  return work;
}
async function git(args: string[], cwd: string, timeout: number): Promise<string> {
  return (await execFileAsync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", cwd, ...args], {
    encoding: "utf8", timeout: Math.max(1, timeout), maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  })).stdout;
}
/** A watcher is deliberately unnecessary: old contents are captured before any managed writes. */
export async function captureWorkspace(cwd: string, directory: string, budget: CaptureBudget = DEFAULT_CAPTURE_BUDGET, quota?: BlobStorageQuota): Promise<WorkspaceSnapshot> {
  const started = Date.now(), deadline = started + budget.maxMs;
  const privateStore = resolve(directory);
  const isPrivateStore = (path: string): boolean => path === privateStore || path.startsWith(privateStore + sep);
  const reasons = new Set<string>();
  const files: Record<string, CapturedFile> = Object.create(null) as Record<string, CapturedFile>;
  let root = cwd, bytesRead = 0, entries = 0, pathBytes = 0;
  let scope: WorkspaceSnapshot["scope"] = "unknown";
  const available = (includeEntries = true): boolean => {
    if (Date.now() >= deadline) { reasons.add("capture-time-budget"); return false; }
    if (includeEntries && entries >= budget.maxEntries) { reasons.add("capture-entry-budget"); return false; }
    if (bytesRead >= budget.maxBytes) { reasons.add("capture-byte-budget"); return false; }
    return true;
  };
  const capture = async (name: string): Promise<void> => {
    if (!safeRelative(name) || name.length > 4096) { reasons.add("unsupported-path"); return; }
    if (name.split(/[\\/]/u).some(part => excluded.has(part))) return;
    if (!available()) return;
    entries++;
    pathBytes += Buffer.byteLength(JSON.stringify(name));
    if (pathBytes > 4 * 1024 * 1024) { reasons.add("capture-path-budget"); return; }
    const path = join(root, name);
    if (isPrivateStore(path)) return;
    try {
      const stat = await lstat(path);
      const common = { bytes: stat.size, mode: stat.mode & 0o777 };
      if (stat.isSymbolicLink()) {
        const target = await readlink(path); files[name] = { ...common, kind: "symlink", hash: sha(target) }; return;
      }
      if (stat.isDirectory()) { files[name] = { ...common, kind: "directory" }; reasons.add("nested-workspace-excluded"); return; }
      if (!stat.isFile()) { files[name] = { ...common, kind: "other" }; return; }
      // Resolve the parent only; never follow a final symlink. Reject symlinked ancestors too.
      const actualParent = await realpath(dirname(path));
      if (actualParent !== resolve(dirname(path))) { reasons.add("symlink-ancestor-excluded"); files[name] = { ...common, kind: "file", unavailable: true }; return; }
      const physicalRelative = relative(root, actualParent);
      if (physicalRelative === ".." || physicalRelative.startsWith(`..${sep}`) || isAbsolute(physicalRelative)) { reasons.add("outside-workspace"); return; }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) throw new Error("file_changed");
        const chunks: Buffer[] = [], hash = createHash("sha256");
        let size = 0;
        while (size < opened.size) {
          if (!available(false)) { files[name] = { ...common, kind: "file", unavailable: true }; return; }
          const length = Math.min(64 * 1024, opened.size - size, budget.maxBytes - bytesRead);
          const chunk = Buffer.allocUnsafe(length);
          const read = await handle.read(chunk, 0, length, size);
          if (!read.bytesRead) break;
          const actual = chunk.subarray(0, read.bytesRead); hash.update(actual); bytesRead += read.bytesRead; size += read.bytesRead;
          if (opened.size <= budget.maxFileBytes) chunks.push(actual);
        }
        const ended = await handle.stat();
        if (size !== opened.size || opened.size !== ended.size || opened.mtimeMs !== ended.mtimeMs || opened.ctimeMs !== ended.ctimeMs) throw new Error("file_changed");
        const digest = hash.digest("hex");
        files[name] = { ...common, kind: "file", hash: digest };
        if (opened.size <= budget.maxFileBytes) {
          if (await putBlob(directory, digest, Buffer.concat(chunks), quota)) files[name]!.blob = digest;
          else { files[name]!.contentUnavailable = true; reasons.add("content-storage-budget"); }
        }
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      reasons.add(error instanceof Error && error.message === "file_changed" ? "file-changed-during-capture" : "unreadable-file");
      files[name] = { kind: "file", bytes: 0, mode: 0, unavailable: true };
    }
  };
  try {
    root = await realpath(cwd);
    let listed: string | undefined;
    let gitRootConfirmed = false;
    try {
      const top = (await git(["rev-parse", "--show-toplevel"], root, deadline - Date.now())).trim();
      root = await realpath(top); gitRootConfirmed = true; scope = "git-visible-files";
      listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root, deadline - Date.now());
    } catch (error) {
      // Only Git's explicit not-a-repository response permits the non-Git walk.
      const failure = error as { stderr?: string; code?: string | number };
      const nonGit = typeof failure.stderr === "string" && /not a git repository/u.test(failure.stderr);
      if (gitRootConfirmed || !nonGit) { reasons.add("git-enumeration-unavailable"); listed = ""; }
    }
    if (listed !== undefined) {
      const seen = new Set<string>();
      for (const name of listed.split("\0")) { if (!name || seen.has(name)) continue; seen.add(name); if (!available()) break; await capture(name); }
    } else {
      scope = "bounded-directory";
      const walk = async (folder: string): Promise<void> => {
        const dir = await opendir(folder);
        try {
          for await (const entry of dir) {
            if (!available()) break;
            if (excluded.has(entry.name)) continue;
            const path = join(folder, entry.name), name = relative(root, path);
            if (isPrivateStore(path)) continue;
            if (entry.isDirectory()) {
              // Nested repositories are not silently included in an unrelated workspace.
              if (await lstat(join(path, ".git")).then(() => true, () => false)) { reasons.add("nested-workspace-excluded"); continue; }
              await walk(path);
            } else await capture(name);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error; }
      };
      await walk(root);
    }
  } catch { reasons.add("workspace-unavailable"); }
  return { scope, root, files, complete: reasons.size === 0, reasons: [...reasons], capturedAt: Date.now() };
}
export async function readCapturedText(directory: string, file: CapturedFile | undefined): Promise<string | undefined> {
  if (!file) return "";
  if (!file.blob || file.kind !== "file") return undefined;
  const bytes = await readFile(blobPath(directory, file.blob));
  if (sha(bytes) !== file.blob) throw new Error("corrupt_content");
  if (bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return undefined; }
}
