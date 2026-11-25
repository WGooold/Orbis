import { randomUUID } from "node:crypto";
import type { InteractionRequest, InteractionResponse, RuntimeCommand, RuntimeEvent } from "@orbis/protocol";
import { agyElicitation } from "./agy-elicitation.js";
import { record, type AcpRequest, type JsonObject } from "./acp-client.js";

const extensionId = "orbis.agy.acp";
export const cancelAgyPermission = (rpc: AcpRequest): void => rpc.respond({ outcome: { outcome: "cancelled" } });

/** The native callback and options stay in the owned connection. App IDs cannot select an unoffered option. */
export class AgyApprovals {
  readonly #pending = new Map<string, { rpc: AcpRequest; request: InteractionRequest; decode: (response: InteractionResponse) => JsonObject | undefined; timer: NodeJS.Timeout }>();
  constructor(private readonly runtimeId: string, private readonly emit: (event: RuntimeEvent) => void) {}
  requests(): InteractionRequest[] { return [...this.#pending.values()].map(item => item.request); }

  add(rpc: AcpRequest): void {
    if (rpc.method === "elicitation/create") {
      const form = agyElicitation(rpc.params);
      if (!form || this.#pending.size >= 16) { rpc.respond({ action: "decline" }); return; }
      const message = typeof rpc.params.message === "string" ? rpc.params.message.trim().slice(0, 512) : "";
      this.#add(rpc, { ...this.#identity(), title: message || "Antigravity CLI", kind: "questionnaire", questions: form.questions }, response => {
        const content = form.decode(response);
        return content ? { action: "accept", content } : undefined;
      });
      return;
    }
    const options = rpc.params.options;
    if (!Array.isArray(options) || options.length > 32 || this.#pending.size >= 16) { cancelAgyPermission(rpc); return; }
    const choices = new Map<string, string>();
    const nativeIds = new Set<string>();
    const visible = [];
    for (const item of options) {
      const { optionId, name, kind } = record(item);
      // No persistent permission escalation from a remote approval.
      if (kind !== "allow_once" && kind !== "reject_once") continue;
      if (typeof optionId !== "string" || !optionId || optionId.length > 512 || nativeIds.has(optionId)) {
        cancelAgyPermission(rpc); return;
      }
      nativeIds.add(optionId);
      const value = randomUUID();
      choices.set(value, optionId);
      visible.push({ value, label: typeof name === "string" && name.trim() ? name.trim().slice(0, 120) : kind === "allow_once" ? "Allow once" : "Deny" });
    }
    if (!visible.length) { cancelAgyPermission(rpc); return; }
    const tool = record(rpc.params.toolCall);
    const title = typeof tool.title === "string" && tool.title.trim() ? tool.title.trim().slice(0, 512) : "Antigravity CLI";
    this.#add(rpc, { ...this.#identity(), kind: "select", title, toolName: title.slice(0, 256), options: visible }, response => {
      const optionId = response.kind === "select" ? choices.get(response.value) : undefined;
      return optionId ? { outcome: { outcome: "selected", optionId } } : undefined;
    });
  }

  #identity() { return { runtimeId: this.runtimeId, requestId: randomUUID(), extensionId, expiresAt: Date.now() + 120_000 }; }

  #add(rpc: AcpRequest, request: InteractionRequest, decode: (response: InteractionResponse) => JsonObject | undefined): void {
    const timer = setTimeout(() => this.#cancel(request.requestId, "timeout"), request.expiresAt - Date.now());
    timer.unref();
    this.#pending.set(request.requestId, { rpc, request, decode, timer });
    this.emit({ type: "interaction.requested", request });
  }

  respond(command: Extract<RuntimeCommand, { type: "interaction.respond" }>): boolean {
    const pending = this.#pending.get(command.requestId);
    if (!pending || command.extensionId !== extensionId) return false;
    if (pending.request.expiresAt <= Date.now()) { this.#cancel(command.requestId, "timeout"); return false; }
    if (command.response.kind === "cancel") { this.#cancel(command.requestId, "cancelled"); return true; }
    const response = pending.decode(command.response);
    if (!response) return false;
    this.#take(command.requestId);
    pending.rpc.respond(response);
    this.emit({ type: "interaction.resolved", requestId: command.requestId, source: "remote" });
    return true;
  }

  clear(reason: "cancelled" | "disconnected" | "owner_closed"): void {
    for (const id of this.#pending.keys()) this.#cancel(id, reason);
  }

  #take(requestId: string) {
    const item = this.#pending.get(requestId);
    if (!item) return;
    this.#pending.delete(requestId);
    clearTimeout(item.timer);
    return item;
  }

  #cancel(requestId: string, reason: "cancelled" | "timeout" | "disconnected" | "owner_closed"): void {
    const item = this.#take(requestId);
    if (!item) return;
    try {
      if (item.rpc.method === "elicitation/create") item.rpc.respond({ action: "cancel" });
      else cancelAgyPermission(item.rpc);
    } catch { /* The pending request no longer owns a writable pipe. */ }
    this.emit({ type: "interaction.cancelled", requestId, reason });
  }
}
