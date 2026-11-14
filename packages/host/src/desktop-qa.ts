import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseQaActivation, type QaActivation } from "@orbis/protocol";

export interface DesktopQaConfiguration { activation: QaActivation; home: string }

/** Only the explicitly QA-compiled desktop supplies these variables to its private bridge. */
export async function loadDesktopQa(env: NodeJS.ProcessEnv): Promise<DesktopQaConfiguration | undefined> {
  if (!env.ORBIS_QA_ACTIVATION_FILE) return undefined;
  if (!env.ORBIS_QA_HOME || !isAbsolute(env.ORBIS_QA_HOME) || !env.ORBIS_HOST_STATE_DIR || !isAbsolute(env.ORBIS_HOST_STATE_DIR)) {
    throw new Error("QA Host requires isolated home and state directories");
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(env.ORBIS_QA_ACTIVATION_FILE, "utf8")); }
  catch { throw new Error("Cannot read valid QA activation JSON"); }
  return { activation: parseQaActivation(value), home: env.ORBIS_QA_HOME };
}
