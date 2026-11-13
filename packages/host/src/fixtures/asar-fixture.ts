/** Test-only Electron ASAR writer matching the format read by `asar-archive.ts`. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type AsarFixtureEntry = string | Buffer | { link: string } | { unpacked: string | Buffer } | { corrupt: string };

/**
 * Write `files` (slash paths → content) as an archive. `{ link }` creates a symlink entry,
 * `{ unpacked }` stores the bytes beside the archive, `{ corrupt }` records a wrong integrity hash.
 */
export async function writeAsarFixture(path: string, files: Record<string, AsarFixtureEntry>): Promise<void> {
  const root: Record<string, unknown> = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [name, entry] of Object.entries(files)) {
    const parts = name.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const children = directory.files as Record<string, Record<string, unknown>>;
      children[part] ??= { files: {} };
      directory = children[part]!;
    }
    const leaf = parts.at(-1)!;
    const children = directory.files as Record<string, unknown>;
    if (typeof entry === "object" && "link" in entry) { children[leaf] = { link: entry.link }; continue; }
    if (typeof entry === "object" && "unpacked" in entry) {
      const body = Buffer.from(entry.unpacked);
      const output = join(`${path}.unpacked`, ...parts);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, body);
      children[leaf] = { size: body.length, unpacked: true, integrity: { algorithm: "SHA256", hash: createHash("sha256").update(body).digest("hex"), blockSize: 4194304, blocks: [] } };
      continue;
    }
    const corrupt = typeof entry === "object" && "corrupt" in entry;
    const body = Buffer.from(corrupt ? (entry as { corrupt: string }).corrupt : entry as string | Buffer);
    const hash = createHash("sha256").update(corrupt ? Buffer.from("different") : body).digest("hex");
    children[leaf] = { size: body.length, offset: String(offset), integrity: { algorithm: "SHA256", hash, blockSize: 4194304, blocks: [hash] } };
    chunks.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padding = (4 - (json.length % 4)) % 4;
  const header = Buffer.alloc(8 + json.length + padding);
  header.writeUInt32LE(4 + json.length + padding, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([size, header, ...chunks]));
}
