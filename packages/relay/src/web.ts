import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { jsonResponse } from "./http-utils.js";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/admin/": ["admin.html", "text/html; charset=utf-8"],
  "/assets/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/assets/site.js": ["site.js", "text/javascript; charset=utf-8"],
  "/assets/admin.js": ["admin.js", "text/javascript; charset=utf-8"],
  "/assets/orbis.png": ["orbis.png", "image/png"],
} as const;
export const downloadNames = [
  "OrbisHost-0.1.4-windows-x64-setup.exe", "OrbisHost-0.1.4-windows-x64.zip",
  "OrbisHost-0.1.3-windows-x64-setup.exe", "OrbisHost-0.1.3-windows-x64.zip",
  "OrbisHost-0.1.2-windows-x64-setup.exe", "OrbisHost-0.1.2-windows-x64.zip",
  "OrbisHost-0.1.0-windows-x64-setup.exe", "OrbisHost-0.1.0-windows-x64.zip",
] as const;

/** Only explicitly listed web assets and release artifacts can be served. */
export async function createWebHandler(downloadsDir?: string): Promise<(request: IncomingMessage, response: ServerResponse, path: string) => Promise<boolean>> {
  const contents = new Map(await Promise.all(Object.entries(assets).map(async ([path, [file, type]]) => [path, { data: await readFile(new URL(`./web/${file}`, import.meta.url)), type }] as const)));
  const downloads: Array<{ name: string; bytes: number; sha256: string; url: string; checksumUrl: string }> = [];
  if (downloadsDir) {
    for (const name of downloadNames) {
      try {
        const info = await stat(join(downloadsDir, name));
        const sha256 = (await readFile(join(downloadsDir, `${name}.sha256`), "utf8")).trim().split(/\s+/)[0]!;
        if (!info.isFile() || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`Invalid release artifact: ${name}`);
        downloads.push({ name, bytes: info.size, sha256, url: `downloads/${name}`, checksumUrl: `downloads/${name}.sha256` });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return async (request, response, path) => {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    if (path === "/admin") { response.writeHead(308, { location: "admin/", "cache-control": "no-store" }).end(); return true; }
    if (path === "/v1/site") { jsonResponse(response, 200, { version: downloads[0]?.name.match(/OrbisHost-(\d+\.\d+\.\d+)/)?.[1] ?? "0.1.4", windows: downloads, android: "https://orbising.com/downloads/orbis.apk" }); return true; }
    if (path.startsWith("/downloads/")) {
      const name = path.slice("/downloads/".length);
      const release = downloads.find(file => name === file.name || name === `${file.name}.sha256`);
      if (!release || !downloadsDir) { jsonResponse(response, 404, { error: "download_unavailable" }); return true; }
      const checksum = name.endsWith(".sha256");
      response.setHeader("content-type", checksum ? "text/plain; charset=utf-8" : "application/octet-stream");
      response.setHeader("content-disposition", `attachment; filename="${name}"`);
      response.setHeader("cache-control", "no-cache");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("x-checksum-sha256", release.sha256);
      if (checksum) { response.end(request.method === "HEAD" ? undefined : `${release.sha256}  ${release.name}\n`); return true; }
      response.setHeader("content-length", release.bytes);
      if (request.method === "HEAD") response.end();
      else await pipeline(createReadStream(join(downloadsDir, name)), response).catch(() => response.destroy());
      return true;
    }
    const asset = contents.get(path);
    if (!asset) return false;
    response.writeHead(200, {
      "content-type": asset.type,
      "content-length": asset.data.length,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...(path === "/admin/" ? { "x-robots-tag": "noindex, nofollow" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : asset.data);
    return true;
  };
}
