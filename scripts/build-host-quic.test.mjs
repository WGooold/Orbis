import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const go = vi.hoisted(() => ({ module: "", root: "" }));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_command, args) => {
    if (args[0] === "build") return "";
    if (args[0] === "list") return `github.com/gorilla/websocket v1.5.3 ${go.module}\n`;
    if (args[0] === "env") return go.root;
    if (args[0] === "version" && args[1] === "-m") return "/cmd/orbis-quic-client\nGOOS=windows\nGOARCH=amd64\n";
    if (args[0] === "version") return "go version fixture";
    throw new Error(`Unexpected Go command ${args.join(" ")}`);
  }),
}));

// HOST-UPDATE-04: exercise the real packaging entry with a read-only Go-cache notice.
// Only the compiler is stubbed; copying, file modes, contents and inventory are real.
it("packages Go module notices as writable files without changing the cache", async () => {
  const artifacts = fileURLToPath(new URL("../.artifacts/", import.meta.url));
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "quic-license-regression-"));
  const previousArgv = process.argv;
  vi.stubEnv("GOOS", "windows"); vi.stubEnv("GOARCH", "amd64");
  try {
    go.module = join(root, "cache", "websocket"); go.root = join(root, "goroot");
    await mkdir(go.module, { recursive: true }); await mkdir(go.root);
    await writeFile(join(go.module, "LICENSE"), "Go module license fixture\n");
    await chmod(join(go.module, "LICENSE"), 0o444);
    await writeFile(join(go.root, "LICENSE"), "Go license fixture\n");
    process.argv = [process.execPath, "build-host-quic.mjs", join(root, "output")];
    await import("./build-host-quic.mjs");
    const license = join(root, "output/licenses/github.com_gorilla_websocket/LICENSE");
    expect(await readFile(license, "utf8")).toBe("Go module license fixture\n");
    expect((await stat(license)).mode & 0o200).toBe(0o200);
    expect((await stat(join(go.module, "LICENSE"))).mode & 0o200).toBe(0);
    const inventory = JSON.parse(await readFile(join(root, "output/DEPENDENCIES.json"), "utf8"));
    expect(inventory.modules[0].license).toBe("licenses/github.com_gorilla_websocket/LICENSE");
  } finally {
    process.argv = previousArgv; vi.unstubAllEnvs();
    await chmod(join(go.module, "LICENSE"), 0o644);
    await rm(root, { recursive: true, force: true });
  }
});
