import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, isAbsolute } from "node:path";

export function codexSelectionPath(): string {
  return join(process.env.ORBIS_AGENT_INSTALL_ROOT ?? join(process.env.LOCALAPPDATA ?? homedir(), "Orbis", "agents"), "codex-selection.json");
}

export async function readCodexSelection(): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(codexSelectionPath(), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1
    || typeof (value as { entry?: unknown }).entry !== "string" || !isAbsolute((value as { entry: string }).entry)) {
    throw new Error("Codex 版本选择记录无效，请从 Agent 页重新选择入口");
  }
  return (value as { entry: string }).entry;
}

export async function saveCodexSelection(entry: string): Promise<void> {
  if (!isAbsolute(entry)) throw new Error("Codex 入口必须是绝对路径");
  const path = codexSelectionPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, entry }), { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
