import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { AgentDeliveryItem, RuntimeCommand, RuntimeEvent } from "@orbis/protocol";
import type { KimiConversation, KimiTurn } from "./kimi-conversation.js";
import { kimiSessionPath, type KimiSessions } from "./kimi-sessions.js";
import { KimiBusinessError } from "./kimi-web-client.js";

type Send = Extract<RuntimeCommand, { type: "user_message" }>;
type Receipt = Extract<RuntimeEvent, { type: "command.result" }>;
const MAX_RECORDS = 4096;
const records = z.array(z.object({ session: z.string().max(128), client: z.string().max(256), prompt: z.string().uuid(), digest: z.string().length(64) })).max(MAX_RECORDS);
type Admission = z.infer<typeof records>[number];
type AdmissionResult = { record: Admission; fresh: boolean; conflict: boolean };

/** Persist the opaque native identity before POST. A duplicate, including after Host restart, is read-only. */
export class KimiPromptJournal {
  #chain: Promise<unknown> = Promise.resolve();
  #data: Map<string, Admission[]> | undefined;
  constructor(readonly path: string) {}
  async load(): Promise<void> {
    if (this.#data) return;
    let entries: Admission[];
    try { entries = records.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries = []; }
    const bySession = new Map<string, Admission[]>();
    for (const entry of entries) {
      const session = bySession.get(entry.session) ?? [];
      if (session.some(item => item.client === entry.client || item.prompt === entry.prompt)) throw new Error("kimi_prompt_journal_conflict");
      session.push(entry); bySession.set(entry.session, session);
    }
    this.#data = bySession;
  }
  existing(session: string, client: string): Admission | undefined { return this.#data?.get(session)?.find(item => item.client === client); }
  aliases(session: string, native: readonly string[]): string[] {
    const ids = new Set(native);
    return this.#data?.get(session)?.filter(item => ids.has(item.prompt)).map(item => item.client) ?? [];
  }
  reserve(session: string, client: string, text: string): Promise<AdmissionResult> {
    const task = this.#chain.then(async () => {
      await this.load();
      const digest = createHash("sha256").update(text).digest("hex");
      const prior = this.existing(session, client);
      if (prior) return { record: prior, fresh: false, conflict: prior.digest !== digest };
      const snapshot = [...this.#data!.values()].flat();
      if (snapshot.length >= MAX_RECORDS) throw new Error("kimi_prompt_journal_full");
      const record = { session, client, digest, prompt: randomUUID() };
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify([...snapshot, record])); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, this.path);
        this.#data!.set(session, [...(this.#data!.get(session) ?? []), record]);
        if (process.platform !== "win32") {
          const directory = await open(dirname(this.path), "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await unlink(temp).catch(() => undefined); }
      return { record, fresh: true, conflict: false };
    });
    this.#chain = task.catch(() => undefined);
    return task;
  }
}

const nativePrompt = z.object({ prompt_id: z.string().min(1).max(256), status: z.enum(["queued", "running", "blocked", "failed"]),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).max(128) });
const nativeQueue = z.object({ active: nativePrompt.nullable(), queued: z.array(nativePrompt).max(4096) });
const aborted = z.object({ aborted: z.literal(true) });
const POLL_MS = 2500;
type Stop = { id: string; turn: string; accepted: boolean; outcome?: KimiTurn };

/** Queue snapshots are observables, not permission to replay or modify the browser queue. */
export class KimiInput {
  readonly #materialized = new Set<string>();
  readonly #commands = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #poll: Promise<z.infer<typeof nativeQueue>> | undefined;
  #closed = false;
  #sending = false;
  #stopping: Stop | undefined;
  #revision = 0;
  #queue: AgentDeliveryItem[] = [];
  #queueKnown = false;
  constructor(readonly options: { sessionId: string; nativeId: string; sessions: KimiSessions; journal: KimiPromptJournal;
    conversation: KimiConversation; emit: (event: RuntimeEvent) => void; idle: () => boolean }) {}
  #result(id: string, status: NonNullable<Receipt["status"]>, error?: string): void {
    this.options.emit({ type: "command.result", commandId: id, ok: status === "success" || status === "pending", status, ...(error ? { error } : {}) });
  }
  #path(): string { return `${kimiSessionPath(this.options.nativeId)}/prompts`; }
  aliases(ids: readonly string[]): readonly string[] { return this.options.journal.aliases(this.options.sessionId, ids); }
  observePromptIds(ids: readonly string[]): void {
    this.#revision++;
    for (const id of ids) {
      this.#materialized.add(id);
      const command = this.#commands.get(id);
      if (command) { this.#commands.delete(id); this.#result(command, "success"); }
    }
    while (this.#materialized.size > 512) this.#materialized.delete(this.#materialized.values().next().value!);
    this.requestPoll();
  }
  observeEnd(turn: KimiTurn): void {
    this.#revision++;
    if (this.#stopping?.turn === turn.turn_id) {
      this.#stopping.outcome = turn;
      if (this.#stopping.accepted) this.#finishStop(this.#stopping, turn);
    }
    this.requestPoll();
  }
  #finishStop(stop: Stop, turn: KimiTurn): void {
    this.#stopping = undefined;
    this.#result(stop.id, turn.outcome === "interrupted" && turn.end_reason === "user_cancelled" ? "success" : "not_cancelable");
  }
  invalidate(): void {
    this.#revision++;
    this.#queueKnown = false;
    if (this.#stopping) { this.#result(this.#stopping.id, "unconfirmed", "kimi_stop_unconfirmed"); this.#stopping = undefined; }
    this.#publishQueue();
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); this.invalidate(); }
  #publishQueue(): void { if (!this.#closed) this.options.emit({ type: "delivery.snapshot", items: this.#queue, complete: this.#queueKnown }); }
  announce(): void { this.#publishQueue(); this.requestPoll(); }
  requestPoll(delay = 0): void {
    if (this.#closed || this.#timer || this.#poll) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.options.conversation.ready) { this.requestPoll(POLL_MS); return; }
      const revision = this.#revision;
      const task = this.#readQueue(); this.#poll = task;
      void task.then(queue => {
        if (this.#closed || revision !== this.#revision) return;
        const items: AgentDeliveryItem[] = []; const seen = new Set<string>();
        let complete = queue.queued.length <= 256;
        for (const row of queue.queued.slice(0, 256)) {
          if (row.status !== "queued" || seen.has(row.prompt_id) || this.#materialized.has(row.prompt_id)) { complete = false; continue; }
          seen.add(row.prompt_id);
          const [alias] = this.aliases([row.prompt_id]);
          const text = row.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
          items.push({ queueId: alias ?? `kimi-queue:${createHash("sha256").update(row.prompt_id).digest("base64url")}`,
            text: text.slice(0, 4096) || "非文本消息", delivery: "followUp", state: "accepted" });
          const command = this.#commands.get(row.prompt_id);
          if (command) { this.#commands.delete(row.prompt_id); this.#result(command, "success"); }
        }
        this.#queue = items; this.#queueKnown = complete; this.#publishQueue();
      }).catch(() => { if (!this.#closed && revision === this.#revision) { this.#queueKnown = false; this.#publishQueue(); } }).finally(() => {
        this.#poll = undefined; this.requestPoll(revision === this.#revision ? POLL_MS : 0);
      });
    }, delay);
    this.#timer.unref();
  }
  #readQueue(): Promise<z.infer<typeof nativeQueue>> { return this.options.sessions.client.requestJson(this.#path()).then(value => nativeQueue.parse(value)); }
  async #assertLocal(): Promise<void> {
    const current = await this.options.sessions.read(this.options.nativeId);
    if (current.id !== this.options.nativeId || current.archived) throw new Error("kimi_session_unavailable");
    await this.options.sessions.requireLocal(current);
    if (this.#closed || !this.options.conversation.ready) throw new Error("kimi_source_unavailable");
  }

  async send(id: string, command: Send): Promise<void> {
    if (!command.messageId || !command.text.trim() || command.delivery !== undefined || command.attachments?.length) {
      this.#result(id, "failure", "Kimi Code 当前只支持普通文本发送"); return;
    }
    const { journal, sessionId, conversation } = this.options;
    if (this.#sending || this.#closed || !conversation.ready) { this.#result(id, "failure", "kimi_source_unavailable"); return; }
    this.#sending = true;
    let dispatched = false;
    try {
      const prior = journal.existing(sessionId, command.messageId);
      if (!prior) {
        await this.#assertLocal();
        const queue = await this.#readQueue();
        if (queue.active || queue.queued.length || conversation.runningTurn || !this.options.idle()) {
          this.#result(id, "failure", "runtime_busy"); return;
        }
      }
      const { record, fresh, conflict } = await journal.reserve(sessionId, command.messageId, command.text);
      if (conflict) { this.#result(id, "message_id_conflict", "message_id_conflict"); return; }
      if (!fresh) {
        this.#result(id, this.#materialized.has(record.prompt) ? "success" : "unconfirmed", this.#materialized.has(record.prompt) ? undefined : "kimi_prompt_unconfirmed");
        return;
      }
      if (this.#closed || !conversation.ready || conversation.runningTurn || !this.options.idle()) {
        this.#result(id, "failure", "runtime_busy"); return;
      }
      this.#commands.set(record.prompt, id);
      this.#result(id, "pending");
      dispatched = true;
      const accepted = nativePrompt.parse(await this.options.sessions.client.requestJson(this.#path(), {
        method: "POST", body: { prompt_id: record.prompt, agent_id: "main", content: [{ type: "text", text: command.text }] },
      }));
      if (accepted.prompt_id !== record.prompt) throw new Error("kimi_prompt_identity_mismatch");
      if (!this.#commands.delete(record.prompt)) return; // authoritative WS/queue observation won the race
      if (accepted.status === "blocked" || accepted.status === "failed") this.#result(id, "failure", "kimi_prompt_rejected");
      else this.#result(id, "success");
    } catch (error) {
      const definite = error instanceof KimiBusinessError && [40001, 40110, 40111, 40112, 40113, 40401, 40927].includes(error.code);
      if (definite) for (const [prompt, commandId] of this.#commands) if (commandId === id) this.#commands.delete(prompt);
      this.#result(id, dispatched && !definite ? "unconfirmed" : "failure", dispatched && !definite ? "kimi_prompt_unconfirmed" : "kimi_prompt_unavailable");
    } finally { this.#sending = false; this.requestPoll(); }
  }

  /** Kimi's bare :abort can race onto a successor. Abort only the current main opener's exact native ID. */
  async stop(id: string): Promise<void> {
    const turn = this.options.conversation.runningTurn;
    const opener = turn?.items?.find(item => item.type === "user_message" && item.placement === "opener");
    if (!turn || !opener?.prompt_ids?.length || this.#stopping) { this.#result(id, "not_cancelable", "kimi_stop_target_unconfirmed"); return; }
    const stop = this.#stopping = { id, turn: turn.turn_id, accepted: false } as Stop;
    let dispatched = false;
    try {
      await this.#assertLocal();
      const native = await this.#readQueue();
      const active = native.active;
      if (this.#stopping !== stop) return;
      if (this.options.conversation.runningTurn?.turn_id !== turn.turn_id || !active || active.status !== "running" || !opener.prompt_ids.includes(active.prompt_id)) {
        this.#result(id, "not_cancelable", "kimi_stop_target_unconfirmed"); this.#stopping = undefined; return;
      }
      dispatched = true;
      aborted.parse(await this.options.sessions.client.requestJson(`${this.#path()}/${encodeURIComponent(active.prompt_id)}:abort`, { method: "POST", body: {} }));
      if (this.#stopping !== stop) return;
      stop.accepted = true;
      if (stop.outcome) { this.#finishStop(stop, stop.outcome); return; }
      this.#result(id, "pending");
      const timer = setTimeout(() => {
        if (this.#stopping !== stop) return;
        this.#result(id, "unconfirmed", "kimi_stop_unconfirmed"); // retain the exact target until its terminal evidence arrives
      }, 8000);
      timer.unref();
    } catch (error) {
      if (this.#stopping !== stop) return;
      const knownAbsent = error instanceof KimiBusinessError && [40401, 40402].includes(error.code);
      if (!dispatched || knownAbsent) { this.#stopping = undefined; this.#result(id, "not_cancelable", "kimi_stop_target_unconfirmed"); }
      else if (stop.outcome) this.#finishStop(stop, stop.outcome);
      else { stop.accepted = true; this.#result(id, "unconfirmed", "kimi_stop_unconfirmed"); }
    } finally { this.requestPoll(); }
  }
}
