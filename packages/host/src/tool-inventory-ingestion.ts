import { agentKeyId, ToolInventoryProducedSchema, toolJsonBytes, toolInventoryPageMatchesSnapshot,
  type AgentKey, type ToolInventoryProduced, type ToolInventoryReference, type ToolSummary } from "@orbis/protocol";
import type { AgentToolInventory, PreparedToolInventory } from "./agent-tool-inventory.js";
import { isDeepStrictEqual } from "node:util";

type Baseline = { reference: ToolInventoryReference; snapshot: ToolInventoryProduced["page"]["snapshot"];
  tools: ToolSummary[]; bytes: number; complete: boolean; updated: number };
const same = isDeepStrictEqual;

/** ADR-0045 §5：producer 页先私有组装，只有对应 conversation 事务提交后才能替换库存。 */
export class ToolInventoryIngestion {
  readonly #pending = new Map<string, Baseline>();
  #bytes = 0;
  #tools = 0;
  constructor(readonly inventory: AgentToolInventory) {}

  accept(runtimeId: string, agent: AgentKey, input: ToolInventoryProduced): boolean {
    this.#sweep();
    const parsed = ToolInventoryProducedSchema.safeParse(input);
    if (!parsed.success) return false;
    const { page, reference } = parsed.data;
    if (page.runtimeId !== runtimeId || agentKeyId(reference.agent) !== agentKeyId(agent) ||
      !same(page.snapshot.agent, reference.agent) || !same(page.snapshot.source, reference.source) ||
      !same(page.snapshot.version, reference.version) || page.snapshot.totalCount !== reference.totalCount) return false;
    if (same(this.inventory.reference(agent), reference)) return true;
    let pending = this.#pending.get(runtimeId);
    if (page.startIndex === 0) {
      if (pending && same(pending.reference, reference) && pending.complete) return true;
      this.release(runtimeId);
      if (this.#pending.size >= 256) return false;
      pending = { reference, snapshot: page.snapshot, tools: [], bytes: 0, complete: false, updated: Date.now() };
      this.#pending.set(runtimeId, pending);
    }
    if (!pending || pending.complete || !same(pending.reference, reference) ||
      !toolInventoryPageMatchesSnapshot(pending.snapshot, page) || page.startIndex !== pending.tools.length) return false;
    const bytes = page.tools.reduce((sum, tool) => sum + toolJsonBytes(tool), 0);
    const ids = new Set(pending.tools.map(tool => tool.tool.toolCallId));
    let last = pending.tools.at(-1);
    for (const tool of page.tools) {
      if (ids.has(tool.tool.toolCallId) || last && (last.order > tool.order ||
        last.order === tool.order && last.tool.toolCallId >= tool.tool.toolCallId)) { this.release(runtimeId); return false; }
      ids.add(tool.tool.toolCallId); last = tool;
    }
    if (pending.tools.length + page.tools.length > 4096 || pending.bytes + bytes > 8 * 1024 * 1024 ||
      this.#bytes + bytes > 32 * 1024 * 1024 || this.#tools + page.tools.length > 16384) { this.release(runtimeId); return false; }
    pending.tools.push(...page.tools); pending.bytes += bytes; pending.updated = Date.now();
    this.#bytes += bytes; this.#tools += page.tools.length;
    if (page.nextCursor === null) {
      if (pending.tools.length !== reference.totalCount || pending.bytes !== reference.summaryBytes) { this.release(runtimeId); return false; }
      pending.complete = true;
    }
    return true;
  }

  prepare(runtimeId: string, agent: AgentKey, source: { epoch: string; seq: number }, reference: ToolInventoryReference): PreparedToolInventory {
    source = { epoch: source.epoch, seq: source.seq };
    this.#sweep();
    const pending = this.#pending.get(runtimeId);
    if (same(this.inventory.reference(agent), reference)) {
      // No replacement is necessary; the already committed fixed version is the exact dependency.
      return { changes: [], reference, publication: null, conversationSource: { agent, ...source }, onCommitted() {} };
    }
    if (!pending?.complete || !same(pending.reference, reference)) throw new Error("tool_inventory_baseline_required");
    const plan = this.inventory.prepare({ agent, runtimeId, source, reference, update: { kind: "baseline", tools: pending.tools } });
    return { ...plan, onCommitted: () => { plan.onCommitted(); if (this.#pending.get(runtimeId) === pending) this.release(runtimeId); } };
  }
  release(runtimeId: string): void {
    const old = this.#pending.get(runtimeId);
    if (old) { this.#bytes -= old.bytes; this.#tools -= old.tools.length; this.#pending.delete(runtimeId); }
  }
  clear(): void { this.#pending.clear(); this.#bytes = 0; this.#tools = 0; }
  #sweep(): void { for (const [id, pending] of this.#pending) if (Date.now() - pending.updated > 30_000) this.release(id); }
}
