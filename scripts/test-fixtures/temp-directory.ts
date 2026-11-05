import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { onTestFinished } from "vitest";

/** Reusable Vitest fixture: remove only its own directory after test teardown, including failures. */
function ownedDirectory(directory: string): string {
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

export async function testDirectory(prefix: string): Promise<string> {
  return ownedDirectory(await mkdtemp(prefix));
}

export function testDirectorySync(prefix: string): string {
  return ownedDirectory(mkdtempSync(prefix));
}
