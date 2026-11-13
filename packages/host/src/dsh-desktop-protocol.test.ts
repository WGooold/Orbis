// ADR-0076 DSH-DESKTOP-08: Orbis loads the DSH protocol only from the connected Desktop's own archive.
// These cases guard the archive reader and the import-closure extraction that replaces the missing `packageEntry`.
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AsarArchive, AsarFormatError } from "./asar-archive.js";
import { DshDesktopProtocolError, dshDesktopProtocolClosure, exportTarget, prepareDshDesktopProtocol } from "./dsh-desktop-protocol.js";
import { writeAsarFixture } from "./fixtures/asar-fixture.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async () => { const root = await mkdtemp(join(tmpdir(), "orbis-dsh-desktop-protocol-")); roots.push(root); return root; };

const nm = "dsh/node_modules";
const pkg = (value: Record<string, unknown>) => JSON.stringify(value);
/** A miniature Desktop runtime: conditional exports, a nested dependency copy, `#imports`, JSON and an unrelated package. */
function runtime(overrides: Record<string, Parameters<typeof writeAsarFixture>[1][string]> = {}): Record<string, Parameters<typeof writeAsarFixture>[1][string]> {
  return {
    [`${nm}/@deepseek-ai/dsh/package.json`]: pkg({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.2", type: "module" }),
    [`${nm}/@deepseek-ai/dsh-desktop-host/package.json`]: pkg({ name: "@deepseek-ai/dsh-desktop-host", version: "0.2.2-rc.2" }),
    [`${nm}/@deepseek-ai/dsh-api-gateway/package.json`]: pkg({ name: "@deepseek-ai/dsh-api-gateway", type: "module",
      exports: { "./stream-protocol": { types: "./lib/types/x.d.ts", default: "./lib/stream-protocol.js" }, "./*": "./lib/*.js" } }),
    [`${nm}/@deepseek-ai/dsh-api-gateway/lib/stream-protocol.js`]: 'import { z } from "zod";\nimport "#constants";\nexport const REMOTE_STREAM_MUX_PATH = "/api/remote.mux";\nexport const REMOTE_EVENT_STREAM_ENDPOINT = "$events";\nexport const REMOTE_EVENT_RESULT_ENDPOINT = "$events/result";\nexport const parseRemoteStreamServerMessage = text => z.parse(JSON.parse(text));\nexport const parseRemoteEventResult = value => value;\n',
    [`${nm}/@deepseek-ai/dsh-api-gateway/lib/constants.js`]: "export const unused = 1;\n",
    [`${nm}/@deepseek-ai/dsh-api-gateway/lib/unrelated.js`]: 'import "left-pad";\n',
    [`${nm}/@deepseek-ai/dsh-api-gateway/package.json#imports`]: "",
    [`${nm}/@deepseek-ai/dsh-client-connection/package.json`]: pkg({ name: "@deepseek-ai/dsh-client-connection", type: "module",
      exports: { ".": { types: "./lib/types/index.d.ts", default: "./lib/index.js" }, "./client": { node: "./lib/client.node.js", browser: "./lib/client.browser.js" } } }),
    [`${nm}/@deepseek-ai/dsh-client-connection/lib/index.js`]: 'import{z}from"zod";export * from "./schema.js";const later = () => import("./lazy.js");export { later };\n',
    [`${nm}/@deepseek-ai/dsh-client-connection/lib/schema.js`]: 'import data from "./data.json" with { type: "json" };\nexport const serverResponseSchema = { parse: value => value };\nexport const fixture = data;\n',
    [`${nm}/@deepseek-ai/dsh-client-connection/lib/data.json`]: '{"ok":true}',
    [`${nm}/@deepseek-ai/dsh-client-connection/lib/lazy.js`]: "export const lazy = true;\n",
    [`${nm}/@deepseek-ai/dsh-client-connection/lib/client.browser.js`]: 'import "browser-only";\n',
    // A nested copy shadows the hoisted zod for this package only.
    [`${nm}/@deepseek-ai/dsh-client-connection/node_modules/zod/package.json`]: pkg({ name: "zod", version: "4.0.0", type: "module", exports: { ".": "./index.js" } }),
    [`${nm}/@deepseek-ai/dsh-client-connection/node_modules/zod/index.js`]: "export const z = { parse: v => v, nested: true };\n",
    [`${nm}/@deepseek-ai/dsh-llm/package.json`]: pkg({ name: "@deepseek-ai/dsh-llm", type: "module", exports: { "./assistant-stream": { import: "./lib/assistant-stream.js", require: "./lib/assistant-stream.cjs" } } }),
    [`${nm}/@deepseek-ai/dsh-llm/lib/assistant-stream.js`]: 'export * from "zod";\nexport const createAssistantStreamDecoder = () => ({ ok: true });\n',
    [`${nm}/@deepseek-ai/dsh-llm/lib/assistant-stream.cjs`]: 'module.exports = require("./cjs-helper");\n',
    [`${nm}/@deepseek-ai/dsh-llm/lib/cjs-helper.js`]: "module.exports = { cjs: true };\n",
    [`${nm}/zod/package.json`]: pkg({ name: "zod", version: "4.1.0", type: "module", exports: { ".": { import: "./index.js", require: "./index.cjs" } } }),
    [`${nm}/zod/index.js`]: "export const z = { parse: v => v };\n",
    [`${nm}/zod/index.cjs`]: "module.exports = { z: { parse: v => v } };\n",
    [`${nm}/left-pad/package.json`]: pkg({ name: "left-pad" }),
    [`${nm}/left-pad/index.js`]: "module.exports = 1;\n",
    [`${nm}/@deepseek-ai/big/package.json`]: pkg({ name: "@deepseek-ai/big" }),
    [`${nm}/@deepseek-ai/big/index.js`]: "x".repeat(4096),
    ...overrides,
  };
}

async function archive(files = runtime()) {
  const root = await temp();
  const path = join(root, "resources", "app.asar");
  const clean = Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith("#imports")));
  const gateway = `${nm}/@deepseek-ai/dsh-api-gateway/package.json`;
  clean[gateway] = pkg({ ...JSON.parse(String(clean[gateway])), imports: { "#constants": "./lib/constants.js" } });
  await writeAsarFixture(path, clean);
  return { root, path };
}

describe("ASAR archive", () => {
  it("reads packed, unpacked and linked files and verifies integrity records", async () => {
    const root = await temp();
    const path = join(root, "app.asar");
    await writeAsarFixture(path, { "a/b.txt": "packed", "native/addon.node": { unpacked: "native-bytes" }, "alias": { link: "a" }, "bad.txt": { corrupt: "tampered" } });
    const value = await AsarArchive.open(path);
    expect((await value.read("a/b.txt")).toString()).toBe("packed");
    expect((await value.read("alias/b.txt")).toString()).toBe("packed");
    expect((await value.read("native/addon.node")).toString()).toBe("native-bytes");
    await expect(value.read("bad.txt")).rejects.toBeInstanceOf(AsarFormatError);
    expect(() => value.isFile("../outside")).toThrow(AsarFormatError);
    expect(value.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects files that are not archives", async () => {
    const root = await temp();
    await writeFile(join(root, "app.asar"), "not an archive");
    await expect(AsarArchive.open(join(root, "app.asar"))).rejects.toBeInstanceOf(AsarFormatError);
  });
});

describe("Desktop protocol closure", () => {
  it("follows the import graph across conditions, nested copies, #imports and dynamic imports only", async () => {
    const { path } = await archive();
    const files = await dshDesktopProtocolClosure(await AsarArchive.open(path));
    expect(files).toContain(`${nm}/@deepseek-ai/dsh-client-connection/node_modules/zod/index.js`);
    expect(files).toContain(`${nm}/@deepseek-ai/dsh-client-connection/lib/lazy.js`);
    expect(files).toContain(`${nm}/@deepseek-ai/dsh-client-connection/lib/data.json`);
    expect(files).toContain(`${nm}/@deepseek-ai/dsh-api-gateway/lib/constants.js`);
    expect(files).toContain(`${nm}/@deepseek-ai/dsh-llm/lib/cjs-helper.js`);
    expect(files).toContain(`${nm}/zod/index.cjs`);
    // Scopes that decide module type travel with their files.
    expect(files).toContain(`${nm}/zod/package.json`);
    // Never extract what the protocol does not reach.
    expect(files.some(file => file.includes("left-pad") || file.includes("/big/") || file.endsWith("client.browser.js") || file.endsWith("unrelated.js"))).toBe(false);
  });

  it("refuses an archive that lacks a protocol module", async () => {
    const files = runtime();
    delete files[`${nm}/@deepseek-ai/dsh-llm/lib/assistant-stream.js`];
    delete files[`${nm}/@deepseek-ai/dsh-llm/lib/assistant-stream.cjs`];
    const { path } = await archive(files);
    await expect(dshDesktopProtocolClosure(await AsarArchive.open(path))).rejects.toBeInstanceOf(DshDesktopProtocolError);
  });

  it("materializes a loadable private copy once and retires older Desktop copies", async () => {
    const { root, path } = await archive();
    const cache = join(root, "cache");
    const first = await prepareDshDesktopProtocol(path, cache);
    expect(first.dshVersion).toBe("0.2.2-rc.2");
    const require = createRequire(first.packageEntry);
    const stream = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-api-gateway/stream-protocol")).href) as { REMOTE_STREAM_MUX_PATH: string };
    expect(stream.REMOTE_STREAM_MUX_PATH).toBe("/api/remote.mux");
    const connection = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-client-connection")).href) as { fixture: unknown };
    expect(connection.fixture).toEqual({ ok: true });
    const marker = (await stat(join(cache, (await readdir(cache))[0]!))).mtimeMs;
    const again = await prepareDshDesktopProtocol(path, cache);
    expect(again.packageEntry).toBe(first.packageEntry);
    expect((await stat(join(cache, (await readdir(cache))[0]!))).mtimeMs).toBe(marker);
    // Two later Desktop versions: only the newest previous copy is kept as rollback.
    for (const version of ["0.2.3", "0.2.4"]) {
      await writeAsarFixture(path, Object.fromEntries(Object.entries(runtime({ [`${nm}/@deepseek-ai/dsh/package.json`]: pkg({ name: "@deepseek-ai/dsh", version, type: "module" }) }))
        .filter(([name]) => !name.endsWith("#imports")).map(([name, value]) => name === `${nm}/@deepseek-ai/dsh-api-gateway/package.json`
          ? [name, pkg({ ...JSON.parse(String(value)), imports: { "#constants": "./lib/constants.js" } })] : [name, value])));
      expect((await prepareDshDesktopProtocol(path, cache)).dshVersion).toBe(version);
    }
    expect((await readdir(cache)).filter(name => !name.startsWith("."))).toHaveLength(2);
  });

  it("selects export targets like Node", () => {
    const exports = { ".": { node: { import: "./n.mjs", require: "./n.cjs" }, default: "./d.js" }, "./feature/*.js": "./lib/*.js", "./feature/internal/*": null };
    expect(exportTarget(exports, ".", ["node", "import", "default"])).toBe("./n.mjs");
    expect(exportTarget(exports, ".", ["node", "require", "default"])).toBe("./n.cjs");
    expect(exportTarget(exports, "./feature/a.js", ["node", "import", "default"])).toBe("./lib/a.js");
    expect(exportTarget(exports, "./feature/internal/x", ["node", "import", "default"])).toBeUndefined();
    expect(exportTarget("./main.js", ".", ["default"])).toBe("./main.js");
  });
});
