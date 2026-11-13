/**
 * Read-only access to an Electron ASAR archive (ADR-0076 DSH-DESKTOP-08).
 *
 * DeepSeek Harness Desktop ships its exact dsh runtime inside `app.asar`. Plain
 * Node cannot import from an archive, so Orbis reads the few protocol files it
 * needs and copies them out. Nothing here writes to, executes or modifies the
 * archive. File content is verified against the archive's own SHA-256
 * integrity record whenever the archive carries one.
 */
import { createHash } from "node:crypto";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** A bounded header keeps a corrupt or hostile archive from exhausting Host memory. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
/** Protocol modules are small bundles; refuse to buffer anything resembling an application payload. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINK_DEPTH = 32;

type FileEntry = { size: number; offset?: string; unpacked?: boolean; integrity?: { algorithm?: string; hash?: string } };
type DirectoryEntry = { files: Record<string, Entry> };
type LinkEntry = { link: string };
type Entry = FileEntry | DirectoryEntry | LinkEntry;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isDirectory = (entry: Entry): entry is DirectoryEntry => "files" in entry && isObject(entry.files);
const isLink = (entry: Entry): entry is LinkEntry => "link" in entry && typeof entry.link === "string";

export class AsarFormatError extends Error {}

/** Normalize an archive path: slash separated, relative, no traversal. */
export function asarPath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new AsarFormatError(`Archive path escapes its root: ${value}`);
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export class AsarArchive {
  /** SHA-256 of the raw header: changes whenever any path, size, offset or integrity record changes. */
  readonly fingerprint: string;
  readonly #path: string;
  readonly #root: DirectoryEntry;
  readonly #dataOffset: number;

  private constructor(path: string, root: DirectoryEntry, dataOffset: number, fingerprint: string) {
    this.#path = path;
    this.#root = root;
    this.#dataOffset = dataOffset;
    this.fingerprint = fingerprint;
  }

  get path(): string { return this.#path; }

  static async open(path: string): Promise<AsarArchive> {
    const handle = await open(path, "r");
    try {
      const size = Buffer.alloc(8);
      if ((await handle.read(size, 0, 8, 0)).bytesRead !== 8 || size.readUInt32LE(0) !== 4) throw new AsarFormatError("Not an ASAR archive");
      const headerSize = size.readUInt32LE(4);
      if (headerSize < 8 || headerSize > MAX_HEADER_BYTES) throw new AsarFormatError("ASAR header size is invalid");
      const header = Buffer.alloc(headerSize);
      if ((await handle.read(header, 0, headerSize, 8)).bytesRead !== headerSize) throw new AsarFormatError("ASAR header is truncated");
      const length = header.readUInt32LE(4);
      if (length > headerSize - 8) throw new AsarFormatError("ASAR header string is truncated");
      let root: unknown;
      try { root = JSON.parse(header.subarray(8, 8 + length).toString("utf8")); }
      catch { throw new AsarFormatError("ASAR header is not valid JSON"); }
      if (!isObject(root) || !isObject(root.files)) throw new AsarFormatError("ASAR header has no file tree");
      return new AsarArchive(path, root as DirectoryEntry, 8 + headerSize, createHash("sha256").update(header).digest("hex"));
    } finally { await handle.close(); }
  }

  #lookup(path: string, depth = 0): Entry | undefined {
    if (depth > MAX_LINK_DEPTH) throw new AsarFormatError("ASAR link loop");
    const parts = asarPath(path).split("/").filter(Boolean);
    let current: Entry = this.#root;
    for (let index = 0; index < parts.length; index += 1) {
      if (isLink(current)) {
        const target = this.#lookup(asarPath(current.link), depth + 1);
        if (target === undefined) return undefined;
        current = target;
      }
      if (!isDirectory(current)) return undefined;
      const next: Entry | undefined = Object.hasOwn(current.files, parts[index]!) ? current.files[parts[index]!] : undefined;
      if (next === undefined || !isObject(next)) return undefined;
      current = next;
    }
    if (isLink(current)) return this.#lookup(asarPath(current.link), depth + 1);
    return current;
  }

  isFile(path: string): boolean {
    const entry = this.#lookup(path);
    return entry !== undefined && !isDirectory(entry) && !isLink(entry) && Number.isSafeInteger((entry as FileEntry).size);
  }

  isDirectory(path: string): boolean {
    const entry = this.#lookup(path);
    return entry !== undefined && isDirectory(entry);
  }

  list(path: string): string[] {
    const entry = this.#lookup(path);
    return entry !== undefined && isDirectory(entry) ? Object.keys(entry.files) : [];
  }

  async read(path: string): Promise<Buffer> {
    const entry = this.#lookup(path);
    if (entry === undefined || isDirectory(entry) || isLink(entry)) throw new AsarFormatError(`Archive file not found: ${path}`);
    const file = entry as FileEntry;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) throw new AsarFormatError(`Archive file is too large: ${path}`);
    let body: Buffer;
    if (file.unpacked === true) {
      body = await readFile(join(`${this.#path}.unpacked`, ...asarPath(path).split("/")));
    } else {
      const offset = Number(file.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new AsarFormatError(`Archive offset is invalid: ${path}`);
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.#path, "r");
        body = Buffer.alloc(file.size);
        if ((await handle.read(body, 0, file.size, this.#dataOffset + offset)).bytesRead !== file.size) throw new AsarFormatError(`Archive file is truncated: ${path}`);
      } finally { await handle?.close(); }
    }
    if (body.byteLength !== file.size) throw new AsarFormatError(`Archive file size changed: ${path}`);
    const integrity = file.integrity;
    if (integrity !== undefined) {
      if (String(integrity.algorithm).toUpperCase() !== "SHA256" || typeof integrity.hash !== "string") throw new AsarFormatError(`Archive integrity record is unsupported: ${path}`);
      if (createHash("sha256").update(body).digest("hex") !== integrity.hash.toLowerCase()) throw new AsarFormatError(`Archive integrity check failed: ${path}`);
    }
    return body;
  }

  async readJson(path: string): Promise<unknown> {
    try { return JSON.parse((await this.read(path)).toString("utf8")) as unknown; }
    catch (error) { if (error instanceof AsarFormatError) throw error; throw new AsarFormatError(`Archive JSON is invalid: ${path}`); }
  }
}
