import { randomUUID } from "node:crypto";
import { agentKeyId } from "./agent-state.js";
import { toolJsonBytes, ToolInventoryPageSchema, TOOL_PAGE_BODY_MAX_BYTES, type ToolSummary,
  type ToolInventoryReference, type ToolInventoryProduced } from "./tool-activity.js";

/** ADR-0045 §5：producer 发布固定版本摘要页；聊天 checkpoint 只携带有界引用。 */
export class ToolInventorySource {
  #reference: ToolInventoryReference | undefined;
  #tools: readonly ToolSummary[] = [];
  #fingerprint = "";
  readonly #publish: (event: ToolInventoryProduced) => void;
  constructor(publish: (event: ToolInventoryProduced) => void) { this.#publish = publish; }
  prepare(runtimeId: string, source: { epoch: string; seq: number }, tools: readonly ToolSummary[], replay = false): ToolInventoryReference | undefined {
    const agent = tools[0]?.tool.agent ?? this.#reference?.agent;
    if (!agent) return undefined;
    if (tools.length > 4096 || tools.some(tool => agentKeyId(tool.tool.agent) !== agentKeyId(agent))) throw new Error("invalid_tool_inventory");
    const sorted = [...tools].sort((a, b) => a.order - b.order || (a.tool.toolCallId < b.tool.toolCallId ? -1 : 1));
    const fingerprint = JSON.stringify(sorted), bytes = toolJsonBytes(sorted) - 2 - Math.max(0, tools.length - 1);
    if (bytes > 8 * 1024 * 1024) throw new Error("tool_inventory_limit");
    const changed = !this.#reference || this.#reference.source.epoch !== source.epoch || this.#fingerprint !== fingerprint;
    if (changed) {
      this.#reference = { projectionVersion: 1, agent, source: { epoch: source.epoch, seq: source.seq }, totalCount: sorted.length, summaryBytes: bytes,
        version: { epoch: this.#reference?.source.epoch === source.epoch ? this.#reference.version.epoch : randomUUID(),
          revision: this.#reference?.source.epoch === source.epoch ? this.#reference.version.revision + 1 : 1 } };
      this.#fingerprint = fingerprint; this.#tools = sorted;
    }
    if (changed || replay) this.#pages(runtimeId);
    return this.#reference;
  }
  #pages(runtimeId: string): void {
    const reference = this.#reference!;
    const snapshot = { snapshotId: randomUUID(), agent: reference.agent, source: reference.source,
      version: reference.version, totalCount: reference.totalCount };
    let start = 0;
    do {
      let end = start;
      const make = (stop: number) => ({ type: "session.tools.page" as const, requestId: `${snapshot.snapshotId}:${start}`, runtimeId,
        snapshot, startIndex: start, endIndex: stop, tools: this.#tools.slice(start, stop),
        nextCursor: stop < this.#tools.length ? String(stop) : null });
      while (end < this.#tools.length && end - start < 128 && toolJsonBytes(make(end + 1)) <= TOOL_PAGE_BODY_MAX_BYTES) end++;
      if (end === start && end < this.#tools.length) throw new Error("tool_summary_too_large");
      this.#publish({ type: "session.tools.produced", reference, page: ToolInventoryPageSchema.parse(make(end)) });
      start = end;
    } while (start < this.#tools.length);
  }
}
