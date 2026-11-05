/** Experimental Relay-only history isolation. Existing wire channels are unchanged. */
export type RelayHistoryMode = "shared" | "background";

export function relayHistoryMode(value: unknown): RelayHistoryMode {
  if (value === undefined || value === "shared") return "shared";
  if (value === "background") return value;
  throw new Error("relayHistoryMode / ORBIS_RELAY_HISTORY_MODE 必须是 shared 或 background");
}
