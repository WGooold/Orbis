import { createHmac, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { MESSAGE_FILE_PREFIX } from "@orbis/protocol";

const maxReferences = 4096;
const unavailable = (): never => { throw new Error("message_file_unavailable"); };
const inside = (dir: string, file: string): boolean => {
  const path = relative(dir, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export function validMessageFilePathText(path: string): boolean {
  for (const ch of path) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) return false;
  }
  return true;
}

/** Bounded Host-owned handles. They keep paths out of the message's actions and cannot be invented by the App. */
export class MessageFileReferences {
  readonly #key = randomBytes(32);
  readonly #paths = new Map<string, { path: string; deviceId: string; cwd?: string; site?: string }>();

  register(path: string, cwd: string | undefined, deviceId: string, runtimeId: string): { referenceId: string; key: string } | undefined {
    // Never reinterpret a foreign absolute path or a Windows device/UNC path as a relative file.
    if (/^[\\/]{2}/u.test(path) || path.startsWith("\\") || (process.platform !== "win32" && /^[a-z]:/iu.test(path)) ||
        (process.platform === "win32" && (path.includes(":") && !/^[a-z]:[\\/][^:]*$/iu.test(path) || path.startsWith("/")))) return undefined;
    const absolute = process.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path);
    if (!absolute && (!cwd || !isAbsolute(cwd))) return undefined;
    const target = absolute ? resolve(path) : resolve(cwd!, path);
    if (!absolute && !inside(cwd!, target)) return undefined;
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const root = absolute ? undefined : cwd;
    // FILE-PREVIEW-03: a page cited inside the session workspace may load workspace files, never the cwd's parents.
    const site = cwd !== undefined && isAbsolute(cwd) && inside(cwd, target) ? cwd : undefined;
    const referenceId = MESSAGE_FILE_PREFIX + createHmac("sha256", this.#key).update(JSON.stringify([deviceId, runtimeId, root ?? null, key])).digest("hex");
    const existing = this.#paths.get(referenceId);
    this.#paths.delete(referenceId);
    this.#paths.set(referenceId, existing ?? { path: target, deviceId, ...(root === undefined ? {} : { cwd: root }), ...(site === undefined ? {} : { site }) });
    while (this.#paths.size > maxReferences) this.#paths.delete(this.#paths.keys().next().value!);
    return { referenceId, key };
  }

  releaseDevice(deviceId: string): void {
    for (const [id, reference] of this.#paths) if (reference.deviceId === deviceId) this.#paths.delete(id);
  }

  async resolve(referenceId: string, deviceId: string): Promise<string> {
    return (await this.resolveIdentity(referenceId, deviceId)).path;
  }

  /**
   * The file now at the cited path. An agent rewriting a report replaces it (often with a new inode); both the
   * earlier and the newer card then open the current file. The returned identity lets one read reject a swap
   * that happens while it is reading; it is not kept across opens.
   */
  async resolveIdentity(referenceId: string, deviceId: string): Promise<{ path: string; identity: string; site?: string }> {
    const target = this.#paths.get(referenceId) ?? unavailable();
    if (target.deviceId !== deviceId) unavailable();
    const file = await realpath(target.path);
    if (target.cwd && !inside(await realpath(target.cwd), file)) unavailable();
    const site = target.site === undefined ? undefined : await realpath(target.site).catch(() => undefined);
    const info = await stat(file, { bigint: true });
    if (!info.isFile()) unavailable();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    return { path: file, identity, ...(site !== undefined && inside(site, file) ? { site } : {}) };
  }
}
