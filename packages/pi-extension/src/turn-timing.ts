import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@pi-remote/protocol";

export function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  return totalSeconds < 60
    ? `${totalSeconds}s`
    : `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

type ActiveTurn = {
  turnId: string;
  startedAt: number;
  turnIndex: number;
};

export class PiTurnTiming {
  readonly #id: () => string;
  readonly #now: () => number;
  #active: ActiveTurn | undefined;

  constructor(id: () => string = randomUUID, now: () => number = Date.now) {
    this.#id = id;
    this.#now = now;
  }

  start(turnIndex: number, timestamp: number): Extract<RuntimeEvent, { type: "turn.started" }> {
    const startedAt = Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : this.#now();
    const turn = { turnId: this.#id(), startedAt, turnIndex };
    this.#active = turn;
    return { type: "turn.started", ...turn };
  }

  finish(
    turnIndex: number,
    messageId?: string,
    persistedMessageId?: string,
    persistedMessages?: readonly { messageId: string; entryId: string }[],
  ): Extract<RuntimeEvent, { type: "turn.finished" }> | undefined {
    const turn = this.#active;
    if (!turn || turn.turnIndex !== turnIndex) return undefined;
    this.#active = undefined;
    return {
      type: "turn.finished",
      ...turn,
      durationMs: Math.max(0, this.#now() - turn.startedAt),
      ...(messageId === undefined ? {} : { messageId }),
      ...(persistedMessageId === undefined ? {} : { persistedMessageId }),
      ...(persistedMessages === undefined || persistedMessages.length === 0
        ? {}
        : { persistedMessages: [...persistedMessages] }),
    };
  }

  reset(): void {
    this.#active = undefined;
  }
}
