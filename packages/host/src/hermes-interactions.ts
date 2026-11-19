import { createHash } from "node:crypto";
import type { InteractionRequest, InteractionResponse, RuntimeCommand, RuntimeEvent } from "@orbis/protocol";

const EXTENSION = "hermes";
const MAX_PROMPTS = 64;
const MAX_WAIT_MS = 5 * 60_000;
type RecordValue = Record<string, unknown>;
type Pending = {
  nativeId: string;
  generation: number;
  kind: "approval" | "clarify";
  request: InteractionRequest;
  decode: (response: InteractionResponse) => string | undefined;
  timer: ReturnType<typeof setTimeout>;
  state: "open" | "submitted" | "settled" | "expired";
};
type Send = (method: string, params: RecordValue) => Promise<unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const validText = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The canonical authority's pending controls, not the legacy server-request transport. */
export class HermesInteractions {
  readonly #pending = new Map<string, Pending>();
  #generation = 0;
  #trusted = true;
  constructor(readonly runtimeId: string, readonly emit: (event: RuntimeEvent) => void) {}

  advance(generation: number): void {
    if (generation === this.#generation) return;
    this.clear("cancelled");
    this.#generation = generation;
  }

  snapshot(): void {
    if (!this.#trusted) return;
    this.emit({ type: "interaction.snapshot", requests: [...this.#pending.values()].flatMap(item =>
      item.state === "open" || item.state === "submitted" ? [{ ...item.request, submitted: item.state === "submitted" }] : []) });
  }

  adopt(prompts: unknown, generation: number): void {
    this.advance(generation);
    if (!Array.isArray(prompts)) return;
    this.#trusted = true;
    const seen = new Set<string>();
    for (const value of prompts.slice(0, MAX_PROMPTS)) {
      const prompt = object(value);
      const id = this.open(prompt, false);
      if (id) seen.add(id);
    }
    for (const [id, item] of this.#pending) if (!seen.has(id)) this.#remove(id, item);
    this.snapshot();
  }

  open(payload: RecordValue, live = true): string | undefined {
    if (!this.#trusted || !validText(payload.prompt_id, 256) || !this.#generation || payload.execution_generation !== this.#generation) return;
    const nativeId = payload.prompt_id;
    const requestId = "hermes:" + createHash("sha256").update(JSON.stringify([this.runtimeId, this.#generation, nativeId])).digest("hex");
    if (this.#pending.has(requestId)) return requestId; // replay does not extend the deadline
    if (this.#pending.size >= MAX_PROMPTS) return;
    const kind = payload.kind;
    const timeout = typeof payload.timeout_s === "number" && payload.timeout_s > 0 && Number.isFinite(payload.timeout_s)
      ? Math.min(MAX_WAIT_MS, Math.ceil(payload.timeout_s * 1000)) : MAX_WAIT_MS;
    const base = { runtimeId: this.runtimeId, requestId, extensionId: EXTENSION, expiresAt: Date.now() + timeout };
    let request: InteractionRequest;
    let decode: Pending["decode"];
    if (kind === "approval") {
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      // Never authorize a hidden/truncated edit or present a durable allowlist option.
      if (!choices.includes("deny") || payload.edit != null || !validText(payload.command, 4_000)) return;
      const allowOnce = choices.includes("once");
      const description = validText(payload.description, 512) ? payload.description : undefined;
      request = { ...base, kind: "select", title: "Hermes 工具审批", ...(description ? { description } : {}),
        argumentSummary: payload.command, options: [...(allowOnce ? [{ value: "once", label: "仅允许本次" }] : []), { value: "deny", label: "拒绝" }] };
      decode = response => response.kind === "cancel" ? "deny" : response.kind !== "select" ? undefined
        : response.value === "deny" || (allowOnce && response.value === "once") ? response.value : undefined;
    } else if (kind === "clarify") {
      if (!validText(payload.question, 4_000) || !Array.isArray(payload.choices) || payload.choices.length > 32 ||
          !payload.choices.every(choice => validText(choice, 512))) return;
      const choices = new Map((payload.choices as string[]).map((label, index) => [`choice-${index}`, label]));
      const options = [...choices].map(([value, label]) => ({ value, label }));
      const title = payload.question;
      const multi = payload.multi_select === true;
      request = options.length === 0 ? { ...base, kind: "input", title, minLength: 1, maxLength: 4_000 }
        : multi ? { ...base, kind: "multi-select", title, options, minSelections: 1, maxSelections: options.length }
          : { ...base, kind: "select", title, options };
      decode = response => {
        if (response.kind === "cancel") return ""; // canonical skip, never an invented answer
        if (!choices.size) return response.kind === "input" && validText(response.value, 4_000) ? response.value : undefined;
        if (!multi) return response.kind === "select" ? choices.get(response.value) : undefined;
        if (response.kind !== "multi-select" || !response.values.length || response.values.length > choices.size ||
            new Set(response.values).size !== response.values.length || response.values.some(value => !choices.has(value))) return;
        const answer = JSON.stringify(response.values.map(value => choices.get(value)));
        return answer.length <= 16_384 ? answer : undefined;
      };
    } else return;
    const timer = setTimeout(() => {
      const item = this.#pending.get(requestId);
      if (!item || item.state === "settled" || item.state === "expired") return;
      item.state = "expired";
      if (this.#trusted) this.emit({ type: "interaction.cancelled", requestId, reason: "timeout" });
      // The native waiter owns its deadline. A local UI expiry never sends an approval RPC.
    }, timeout);
    timer.unref?.();
    this.#pending.set(requestId, { nativeId, generation: this.#generation, kind, request, decode, timer, state: "open" });
    if (live) this.emit({ type: "interaction.requested", request });
    return requestId;
  }

  settled(kind: Pending["kind"], payload: RecordValue): void {
    for (const [id, item] of this.#pending) {
      if (item.kind !== kind || item.nativeId !== payload.prompt_id || item.generation !== payload.execution_generation) continue;
      const wasOpen = item.state === "open";
      if (item.state === "submitted") {
        // The event can precede the RPC reply. It proves absence, not who answered or what was chosen.
        item.state = "settled";
        clearTimeout(item.timer);
        this.snapshot();
      } else {
        this.#remove(id, item);
        if (wasOpen && this.#trusted) this.emit({ type: "interaction.cancelled", requestId: id, reason: "cancelled" });
      }
      return;
    }
  }

  async respond(sessionId: string, command: Extract<RuntimeCommand, { type: "interaction.respond" }>,
    send: Send): Promise<"success" | "failure" | "unconfirmed"> {
    const id = command.requestId;
    const item = this.#pending.get(id);
    if (!this.#trusted || command.extensionId !== EXTENSION || !item || item.state !== "open" || Date.now() >= item.request.expiresAt) return "failure";
    const answer = item.decode(command.response);
    if (answer === undefined) return "failure";
    item.state = "submitted";
    this.snapshot();
    const result = object(await send(`${item.kind}.respond`, { session_id: sessionId, execution_generation: item.generation,
      prompt_id: item.nativeId, [item.kind === "approval" ? "choice" : "answer"]: answer }));
    if (result.prompt_id !== item.nativeId || (result.status !== "resolved" && result.status !== "already_resolved")) return "unconfirmed";
    if (this.#pending.get(id) === item) {
      this.#remove(id, item);
      this.emit(result.status === "resolved" ? { type: "interaction.resolved", requestId: id, source: "remote" }
        : { type: "interaction.cancelled", requestId: id, reason: "cancelled" });
    }
    return result.status === "resolved" ? "success" : "failure";
  }

  clear(reason: "cancelled" | "disconnected" | "owner_closed"): void {
    for (const [id, item] of this.#pending) {
      this.#remove(id, item);
      if (this.#trusted && (item.state === "open" || item.state === "submitted")) this.emit({ type: "interaction.cancelled", requestId: id, reason });
    }
  }

  invalidate(): void {
    if (!this.#trusted) return;
    this.#trusted = false;
    for (const [requestId, item] of this.#pending) {
      if (item.state === "open" || item.state === "submitted") this.emit({ type: "interaction.cancelled", requestId, reason: "disconnected" });
    }
    // Preserve submitted/expired fences until the same-generation authoritative snapshot, not a replay.
  }

  #remove(id: string, item: Pending): void { clearTimeout(item.timer); this.#pending.delete(id); }
}
