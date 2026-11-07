import type { AgentTask, AgentTaskInventory } from "@orbis/protocol";
import { agentTaskInventory, mergeAgentTaskInventory } from "./agent-tasks.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const identity = (value: unknown): string | undefined => typeof value === "string" && value.trim().length > 0 && value.length <= 256 ? value : undefined;
const label = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** Codex 0.165 app-server generated SessionSource / Thread fields; older servers use subAgent. */
export function codexChildThread(value: unknown): { id: string; parentId: string; title?: string; kind?: string; status: unknown } | undefined {
  const thread = object(value), source = object(thread.source), child = object(source.subagent ?? source.subAgent);
  const spawn = object(child.thread_spawn);
  const id = identity(thread.id), parentId = identity(thread.parentThreadId) ?? identity(spawn.parent_thread_id);
  if (!id || !parentId || id === parentId) return undefined;
  const title = label(thread.agentNickname ?? spawn.agent_nickname, 80);
  const kind = label(thread.agentRole ?? spawn.agent_role, 48);
  return { id, parentId, ...(title ? { title } : {}), ...(kind ? { kind } : {}), status: thread.status };
}

function agentStatus(value: unknown): AgentTask["status"] | undefined {
  switch (value) {
    case "pendingInit": return "pending";
    case "running": return "running";
    // Interrupted execution leaves the agent thread alive and available for another input.
    case "interrupted": return "idle";
    case "completed": return "completed";
    case "errored": return "failed";
    case "shutdown": return "killed";
    case "notFound": return "unknown";
    default: return undefined;
  }
}

function threadStatus(value: unknown): AgentTask["status"] {
  const status = object(value);
  if (status.type === "idle") return "idle";
  if (status.type === "active") return Array.isArray(status.activeFlags)
    && status.activeFlags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running";
  return "unknown";
}

/** Collaboration records report only some children, never a complete task inventory.
 * The call's own status (including completed wait/spawn) is not an agent lifecycle.
 * Only native short identity/display fields enter shared state; prompt/result/model stay private. */
export class CodexAgentTasks {
  #inventory: AgentTaskInventory = agentTaskInventory([], "unknown");
  #live = new Map<string, { itemId: string; status: AgentTask["status"] }>();
  #replaying = false;
  constructor(readonly rootId: string) {}
  snapshot(): AgentTaskInventory { return structuredClone(this.#inventory); }
  has(id: string): boolean { return this.#inventory.items.some(item => item.id === id); }
  stale(): AgentTaskInventory {
    this.#live.clear();
    this.#inventory = agentTaskInventory(this.#inventory.items, "unknown");
    return this.snapshot();
  }

  #task(id: string, status?: AgentTask["status"], parentId?: string, title?: string, kind?: string): AgentTask {
    const previous = this.#inventory.items.find(item => item.id === id);
    const parent = parentId === undefined ? previous?.parentId : parentId === this.rootId ? undefined : parentId;
    return { id, title: title ?? previous?.title ?? id, kind: kind ?? previous?.kind ?? "subagent",
      status: status ?? (this.#inventory.truncated ? previous?.status : undefined) ?? "unknown", ...(parent ? { parentId: parent } : {}) };
  }

  #merge(items: AgentTask[], itemId?: string): AgentTaskInventory | undefined {
    if (!items.length) return undefined;
    if (itemId) {
      if (this.#replaying) items = items.map(item => {
        const live = this.#live.get(item.id);
        return live?.itemId === itemId ? { ...item, status: live.status } : item;
      });
      else for (const item of items) this.#live.set(item.id, { itemId, status: item.status });
    } else if (!this.#replaying) {
      // A later native registry status can resume a child after an older completed call.
      for (const item of items) {
        const live = this.#live.get(item.id);
        if (live) this.#live.set(item.id, { ...live, status: item.status });
      }
    }
    const incoming = mergeAgentTaskInventory(this.#inventory, agentTaskInventory(items, "unknown", true));
    const retained = new Set(incoming.items.map(item => item.id));
    for (const id of this.#live.keys()) if (!retained.has(id)) this.#live.delete(id);
    if (JSON.stringify(incoming) === JSON.stringify(this.#inventory)) return undefined;
    this.#inventory = incoming;
    return this.snapshot();
  }

  #threadStatus(id: string, value: unknown): AgentTask["status"] {
    const observed = threadStatus(value), previous = this.#inventory.items.find(item => item.id === id)?.status;
    // Registry idle/notLoaded does not undo an explicit completed/errored/shutdown task.
    return this.#inventory.truncated && (observed === "idle" || observed === "unknown") && previous && ["completed", "failed", "killed"].includes(previous) ? previous : observed;
  }

  observeThread(value: unknown): AgentTaskInventory | undefined {
    const child = codexChildThread(value);
    return child ? this.#merge([this.#task(child.id, this.#threadStatus(child.id, child.status), child.parentId, child.title, child.kind)]) : undefined;
  }

  observeStatus(id: string, status: unknown): AgentTaskInventory | undefined {
    return this.has(id) ? this.#merge([this.#task(id, this.#threadStatus(id, status))]) : undefined;
  }

  observeItem(value: unknown): AgentTaskInventory | undefined {
    const item = object(value);
    if (!identity(item.id)) return undefined;
    if (item.type === "subAgentActivity") {
      const id = identity(item.agentThreadId);
      if (!id || id === this.rootId) return undefined;
      const status = item.kind === "started" ? "running" : item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "idle" : undefined;
      return this.#merge([this.#task(id, status, undefined, label(item.agentPath, 80))], item.id as string);
    }
    if (item.type !== "collabAgentToolCall") return undefined;
    const states = object(item.agentsStates);
    const ids = new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []), ...Object.keys(states)]);
    const parent = item.tool === "spawnAgent" ? identity(item.senderThreadId) : undefined;
    const items: AgentTask[] = [];
    for (const value of ids) {
      const id = identity(value);
      if (!id || id === this.rootId || id === parent) continue;
      const state = object(states[id]);
      items.push(this.#task(id, agentStatus(state.status) ?? (state.status === undefined ? undefined : "unknown"), parent));
    }
    return this.#merge(items, item.id as string);
  }

  /** Replay is applied only after the caller validates/commits its native history generation.
   * Missing children are retained: a bounded or reverted transcript is not their registry. */
  replay(turns: readonly unknown[]): AgentTaskInventory | undefined {
    const before = JSON.stringify(this.#inventory), seen = new Set<string>();
    this.#replaying = true;
    try {
      for (const turn of turns) {
        const items = object(turn).items;
        if (Array.isArray(items)) for (const item of items) {
          const id = identity(object(item).id);
          if (id) seen.add(id);
          this.observeItem(item);
        }
      }
      // Active persistence may precede the last live fact. It cannot revoke an observed
      // lifecycle; later native items still supersede an earlier matching live item.
      this.#merge([...this.#live].filter(([, live]) => !seen.has(live.itemId))
        .map(([id, live]) => this.#task(id, live.status)));
    } finally { this.#replaying = false; }
    return JSON.stringify(this.#inventory) === before ? undefined : this.snapshot();
  }
}
