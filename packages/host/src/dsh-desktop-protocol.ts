/**
 * Version-matched DSH protocol library for one DeepSeek Harness Desktop install
 * (ADR-0076 DSH-DESKTOP-08).
 *
 * Desktop carries `@deepseek-ai/dsh` and its whole production tree inside
 * `resources/app.asar/dsh`. Orbis needs only the Gateway stream protocol, the
 * Connection response schema and the assistant-stream decoder from exactly that
 * tree. It follows their import graph inside the archive, verifies every file
 * against the archive integrity record, and materializes that closure in a
 * private cache keyed by the archive header. A separate npm `dsh` is never used.
 */
import { randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AsarArchive, asarPath } from "./asar-archive.js";

export const DSH_DESKTOP_RUNTIME_ROOT = "dsh";
export const DSH_DESKTOP_PACKAGE_DIR = `${DSH_DESKTOP_RUNTIME_ROOT}/node_modules/@deepseek-ai/dsh`;
export const DSH_DESKTOP_HOST_PACKAGE_DIR = `${DSH_DESKTOP_RUNTIME_ROOT}/node_modules/@deepseek-ai/dsh-desktop-host`;
/** The three entry points Orbis's DSH Web transport and history decoder load (see dsh-web-client / dsh-web-history). */
export const DSH_DESKTOP_PROTOCOL_SPECIFIERS = [
  "@deepseek-ai/dsh-api-gateway/stream-protocol",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-llm/assistant-stream",
] as const;
const MANIFEST = "orbis-dsh-desktop-protocol.json";
const MAX_FILES = 5_000;
const MAX_BYTES = 64 * 1024 * 1024;
const CONDITION_SETS = [["node", "import", "default"], ["node", "require", "default"]] as const;
const SCRIPT = /\.(?:m|c)?js$/u;
const BUILTINS = new Set(builtinModules);
const SPECIFIERS = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["']([^"'\n]{1,512})["']|\bimport\s*\(\s*["']([^"'\n]{1,512})["']\s*\)|\brequire\s*\(\s*["']([^"'\n]{1,512})["']\s*\)/gu;

export class DshDesktopProtocolError extends Error {}

export type DshDesktopProtocolLibrary = {
  /** Path inside the private copy used as the `createRequire` anchor by the existing loaders. */
  packageEntry: string;
  dshVersion: string;
  fingerprint: string;
  files: number;
};

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const parent = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

class ArchiveResolver {
  readonly #archive: AsarArchive;
  readonly #manifests = new Map<string, Record<string, unknown> | undefined>();
  constructor(archive: AsarArchive) { this.#archive = archive; }

  async manifest(directory: string): Promise<Record<string, unknown> | undefined> {
    if (this.#manifests.has(directory)) return this.#manifests.get(directory);
    const path = directory ? `${directory}/package.json` : "package.json";
    let value: Record<string, unknown> | undefined;
    if (this.#archive.isFile(path)) {
      const parsed = await this.#archive.readJson(path).catch(() => undefined);
      value = isObject(parsed) ? parsed : undefined;
    }
    this.#manifests.set(directory, value);
    return value;
  }

  /** The package scope that decides a file's module type and `#imports`. */
  async scope(file: string): Promise<string | undefined> {
    for (let directory = parent(file); ; directory = parent(directory)) {
      if (await this.manifest(directory) !== undefined) return directory;
      if (directory === "") return undefined;
    }
  }

  #file(path: string): string | undefined {
    if (this.#archive.isFile(path)) return path;
    for (const extension of [".js", ".json", ".mjs", ".cjs"]) if (this.#archive.isFile(path + extension)) return path + extension;
    return undefined;
  }

  async #fileOrDirectory(path: string): Promise<string | undefined> {
    const file = this.#file(path);
    if (file !== undefined) return file;
    if (!this.#archive.isDirectory(path)) return undefined;
    const main = (await this.manifest(path))?.main;
    if (typeof main === "string") {
      const resolved = this.#file(asarPath(`${path}/${main}`)) ?? this.#file(asarPath(`${path}/${main}/index`));
      if (resolved !== undefined) return resolved;
    }
    return this.#file(`${path}/index`);
  }

  async resolve(importer: string, specifier: string): Promise<string[]> {
    if (specifier.startsWith("node:") || BUILTINS.has(specifier) || BUILTINS.has(specifier.split("/")[0]!) || /^[a-z][a-z0-9+.-]*:/iu.test(specifier)) return [];
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      let path: string;
      try { path = asarPath(`${parent(importer)}/${specifier}`); } catch { return []; }
      const resolved = await this.#fileOrDirectory(path);
      return resolved === undefined ? [] : [resolved];
    }
    if (specifier.startsWith("#")) return this.#imports(importer, specifier);
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
    if (!name || name.startsWith(".")) return [];
    for (let directory = parent(importer); ; directory = parent(directory)) {
      if (!directory.endsWith("node_modules")) {
        const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
        if (this.#archive.isDirectory(candidate)) return this.#package(candidate, subpath);
      }
      if (directory === "") return [];
    }
  }

  async #package(directory: string, subpath: string): Promise<string[]> {
    const manifest = await this.manifest(directory);
    if (manifest?.exports !== undefined) {
      const results = new Set<string>();
      for (const conditions of CONDITION_SETS) {
        const target = exportTarget(manifest.exports, subpath ? `./${subpath}` : ".", conditions);
        if (target === undefined || !target.startsWith("./")) continue;
        let path: string;
        try { path = asarPath(`${directory}/${target}`); } catch { continue; }
        if (!path.startsWith(`${directory}/`)) continue;
        if (this.#archive.isFile(path)) results.add(path);
      }
      return [...results];
    }
    const resolved = subpath ? await this.#fileOrDirectory(`${directory}/${subpath}`) : await this.#fileOrDirectory(directory);
    return resolved === undefined ? [] : [resolved];
  }

  async #imports(importer: string, specifier: string): Promise<string[]> {
    const scope = await this.scope(importer);
    if (scope === undefined) return [];
    const imports = (await this.manifest(scope))?.imports;
    if (!isObject(imports)) return [];
    const results: string[] = [];
    for (const conditions of CONDITION_SETS) {
      const target = exportTarget(imports, specifier, conditions);
      if (target === undefined) continue;
      if (target.startsWith("./")) {
        try {
          const path = asarPath(`${scope}/${target}`);
          if (this.#archive.isFile(path)) results.push(path);
        } catch { /* An escaping target is not part of this package. */ }
      } else results.push(...await this.resolve(scope ? `${scope}/package.json` : "package.json", target));
    }
    return [...new Set(results)];
  }
}

/** Node's package `exports` / `imports` target selection for one condition set. */
export function exportTarget(map: unknown, subpath: string, conditions: readonly string[]): string | undefined {
  const sugar = typeof map === "string" || Array.isArray(map) || isObject(map) && !Object.keys(map).some(key => key.startsWith(".") || key.startsWith("#"));
  const table = sugar ? { ".": map } : map;
  if (!isObject(table)) return undefined;
  if (Object.hasOwn(table, subpath) && !subpath.includes("*")) return target(table[subpath], conditions, undefined);
  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(table)) {
    const star = key.indexOf("*");
    if (star < 0 || key.indexOf("*", star + 1) >= 0) continue;
    const prefix = key.slice(0, star), suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
    if (best === undefined || prefix.length > best.key.indexOf("*")) best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
  }
  return best === undefined ? undefined : target(table[best.key], conditions, best.match);
}

function target(value: unknown, conditions: readonly string[], match: string | undefined): string | undefined {
  if (typeof value === "string") return match === undefined ? value : value.replaceAll("*", match);
  if (Array.isArray(value)) {
    for (const item of value) { const resolved = target(item, conditions, match); if (resolved !== undefined) return resolved; }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key !== "default" && !conditions.includes(key)) continue;
    const resolved = target(item, conditions, match);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function specifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(SPECIFIERS)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.add(value);
  }
  return [...found];
}

/** Collect the archive files reached from the protocol entry points, plus the manifests that define their module scope. */
export async function dshDesktopProtocolClosure(archive: AsarArchive): Promise<string[]> {
  const anchor = `${DSH_DESKTOP_PACKAGE_DIR}/package.json`;
  if (!archive.isFile(anchor)) throw new DshDesktopProtocolError("Desktop 安装包中没有 dsh 运行时");
  const resolver = new ArchiveResolver(archive);
  const files = new Set<string>([anchor]);
  const queue: string[] = [];
  for (const specifier of DSH_DESKTOP_PROTOCOL_SPECIFIERS) {
    const resolved = await resolver.resolve(anchor, specifier);
    if (resolved.length === 0) throw new DshDesktopProtocolError(`Desktop 运行时缺少协议模块 ${specifier}`);
    queue.push(...resolved);
  }
  let bytes = 0;
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    if (files.size > MAX_FILES) throw new DshDesktopProtocolError("Desktop 协议依赖超出预期范围");
    const scope = await resolver.scope(file);
    if (scope !== undefined) files.add(scope ? `${scope}/package.json` : "package.json");
    if (!SCRIPT.test(file)) continue;
    const body = await archive.read(file);
    bytes += body.byteLength;
    if (bytes > MAX_BYTES) throw new DshDesktopProtocolError("Desktop 协议依赖超出预期大小");
    // Unresolvable specifiers are strings in code or optional platform branches. A
    // module that is really required fails the post-extraction load instead.
    for (const specifier of specifiers(body.toString("utf8"))) for (const next of await resolver.resolve(file, specifier)) if (!files.has(next)) queue.push(next);
  }
  return [...files].sort();
}

async function readManifest(directory: string, fingerprint: string): Promise<{ dshVersion: string; files: string[] } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, MANIFEST), "utf8"));
    if (!isObject(value) || value.version !== 1 || value.fingerprint !== fingerprint || typeof value.dshVersion !== "string"
      || !Array.isArray(value.files) || !value.files.every(file => typeof file === "string")) return undefined;
    // A partially deleted cache must be rebuilt rather than half-loaded.
    for (const file of value.files as string[]) await stat(join(directory, ...file.split("/")));
    return { dshVersion: value.dshVersion, files: value.files as string[] };
  } catch { return undefined; }
}

/**
 * Materialize the protocol closure for this archive once and return its loader anchor.
 * The cache directory is named by the archive header fingerprint, so a Desktop
 * update yields a fresh copy and the previous one is retired.
 */
export async function prepareDshDesktopProtocol(archivePath: string, cacheRoot: string): Promise<DshDesktopProtocolLibrary> {
  const archive = await AsarArchive.open(archivePath);
  const manifest = await archive.readJson(`${DSH_DESKTOP_PACKAGE_DIR}/package.json`).catch(() => undefined);
  const dshVersion = isObject(manifest) && typeof manifest.version === "string" ? manifest.version : undefined;
  if (dshVersion === undefined) throw new DshDesktopProtocolError("无法读取 Desktop 内置 dsh 版本");
  const name = archive.fingerprint.slice(0, 40);
  const directory = join(cacheRoot, name);
  const packageEntry = join(directory, ...DSH_DESKTOP_PACKAGE_DIR.split("/"), "package.json");
  const cached = await readManifest(directory, archive.fingerprint);
  if (cached !== undefined) return { packageEntry, dshVersion: cached.dshVersion, fingerprint: archive.fingerprint, files: cached.files.length };
  const files = await dshDesktopProtocolClosure(archive);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const temporary = join(cacheRoot, `.${name}.${randomUUID()}.tmp`);
  try {
    for (const file of files) {
      const output = join(temporary, ...file.split("/"));
      await mkdir(join(output, ".."), { recursive: true, mode: 0o700 });
      await writeFile(output, await archive.read(file), { mode: 0o600 });
    }
    await writeFile(join(temporary, MANIFEST), JSON.stringify({ version: 1, fingerprint: archive.fingerprint, dshVersion, archive: archivePath, files }), { mode: 0o600 });
    await rm(directory, { recursive: true, force: true });
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    // A concurrent Host may have published the same verified copy first.
    const winner = await readManifest(directory, archive.fingerprint);
    if (winner !== undefined) return { packageEntry, dshVersion: winner.dshVersion, fingerprint: archive.fingerprint, files: winner.files.length };
    throw error;
  }
  await retireOtherCopies(cacheRoot, name);
  return { packageEntry, dshVersion, fingerprint: archive.fingerprint, files: files.length };
}

/** Remove only copies this module created (they carry its manifest), keeping the newest previous one as a rollback. */
async function retireOtherCopies(cacheRoot: string, current: string): Promise<void> {
  const others: Array<{ path: string; modified: number }> = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === current) continue;
    const path = join(cacheRoot, entry.name);
    if (entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      // Abandoned extraction from a crashed Host; older than an hour cannot be in progress.
      const modified = (await stat(path).catch(() => undefined))?.mtimeMs ?? Date.now();
      if (Date.now() - modified > 3_600_000) await rm(path, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    const marker = await stat(join(path, MANIFEST)).catch(() => undefined);
    if (marker !== undefined) others.push({ path, modified: marker.mtimeMs });
  }
  others.sort((a, b) => b.modified - a.modified);
  for (const other of others.slice(1)) await rm(other.path, { recursive: true, force: true }).catch(() => {});
}
