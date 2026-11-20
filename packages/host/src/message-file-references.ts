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

/** Bounded Host-owned handles. They keep paths out of the message's actions and cannot be invented by the App. */
export class MessageFileReferences {
  readonly #key = randomBytes(32);
  readonly #paths = new Map<string, { path: string; deviceId: string; cwd?: string; resolved?: string; identity?: string }>();

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
    const referenceId = MESSAGE_FILE_PREFIX + createHmac("sha256", this.#key).update(JSON.stringify([deviceId, runtimeId, root ?? null, key])).digest("hex");
    const existing = this.#paths.get(referenceId);
    this.#paths.delete(referenceId);
    this.#paths.set(referenceId, existing ?? { path: target, deviceId, ...(root === undefined ? {} : { cwd: root }) });
    while (this.#paths.size > maxReferences) this.#paths.delete(this.#paths.keys().next().value!);
    return { referenceId, key };
  }

  releaseDevice(deviceId: string): void {
    for (const [id, reference] of this.#paths) if (reference.deviceId === deviceId) this.#paths.delete(id);
  }

  async resolve(referenceId: string, deviceId: string): Promise<string> {
    return (await this.resolveIdentity(referenceId, deviceId)).path;
  }

  async resolveIdentity(referenceId: string, deviceId: string): Promise<{ path: string; identity: string }> {
    const target = this.#paths.get(referenceId) ?? unavailable();
    if (target.deviceId !== deviceId) unavailable();
    const file = await realpath(target.path);
    if (target.cwd && !inside(await realpath(target.cwd), file)) unavailable();
    const info = await stat(file, { bigint: true });
    if (!info.isFile()) unavailable();
    const identity = `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    if (target.resolved !== undefined && (target.resolved !== file || target.identity !== identity)) unavailable();
    target.resolved = file; target.identity = identity;
    return { path: file, identity };
  }
}
