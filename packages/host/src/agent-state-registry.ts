import { randomUUID } from "node:crypto";

import {
  agentKeyId, type AgentKey, type AgentStateDomain, type DomainAvailability,
  type DomainCompleteness, type DomainSource, type DomainState, type HostStateDomain,
} from "@pi-remote/protocol";

/**
 * Host 端的 Agent 状态模型单写者（ADR-0032 §1/§6，issue #5 的实现）。
 *
 * 职责边界：
 * - 适配层先把原生事实归一成 snapshot/transaction，再调用这里；Registry 只做校验与提交，
 *   它的 API 全是同步的，**不会**在提交路径里发起原生 RPC、文件 IO 或网络探测。
 * - 提交是原子的：先落库，再通知订阅者；订阅者读到的就是已提交状态。
 * - 只有同一有效来源、`ready` + `complete` 的清单能用「缺席」删除条目。部分清单只合并，
 *   未知/失败保留最后已知值并标明待核对。
 * - 内容没变就不推进版本（心跳、分页请求、其他设备回执不冒充源端内容变化）。
 * - 这里只保存各领域的**当前投影**，不保存全量聊天历史。
 */

const DEFAULT_MAX_VALUE_BYTES = 262_144;
const DEFAULT_MAX_ENTRIES = 512;

export type StateScope = { readonly kind: "host" } | { readonly kind: "agent"; readonly key: AgentKey };
export type StateDomain = AgentStateDomain | HostStateDomain;

export type DomainFact = {
  readonly source: DomainSource;
  readonly availability: DomainAvailability;
  readonly completeness: DomainCompleteness;
  /** 捕获这份事实时的宿主模型代次；不一致说明是迟到响应。省略表示按当前代次处理。 */
  readonly modelEpoch?: string;
};
export type ValueFact<T> = DomainFact & { readonly value: T };
/** 集合领域用一个按 id 索引的对象表示，Registry 才能安全地实施「缺席删除」。 */
export type CollectionFact = DomainFact & { readonly items: Readonly<Record<string, unknown>> };

export type CommitCode =
  | "invalid_fact"
  | "stale_model_epoch"
  | "source_conflict"
  | "source_epoch_baseline_required"
  | "value_too_large"
  | "registry_full";

export type CommitResult =
  | { readonly ok: true; readonly revision: number; readonly changed: boolean }
  | { readonly ok: false; readonly code: CommitCode; readonly detail?: string };

export type BaselineAction = "unchanged" | "state" | "baseline";
export type BaselineRead<T> = { readonly action: BaselineAction; readonly state: DomainState<T> | null };

export type RegistryChange =
  | { readonly kind: "committed"; readonly scope: StateScope; readonly domain: StateDomain; readonly state: DomainState<unknown> }
  | { readonly kind: "closed"; readonly scope: StateScope; readonly domain: StateDomain }
  | { readonly kind: "reset"; readonly modelEpoch: string };

export type RegistryListener = (change: RegistryChange) => void;

export type RegistryOptions = {
  /** 认证生命周期确认的模型代次；缺省时自己生成一个。 */
  readonly modelEpoch?: string;
  readonly now?: () => number;
  readonly maxValueBytes?: number;
  readonly maxEntries?: number;
};

type Entry = {
  readonly scope: StateScope;
  readonly domain: StateDomain;
  readonly fingerprint: string;
  state: DomainState<unknown>;
};

const scopeId = (scope: StateScope): string => scope.kind === "host" ? "host" : "agent:" + agentKeyId(scope.key);
const entryKey = (scope: StateScope, domain: StateDomain): string => scopeId(scope) + "\u0000" + domain;
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export class AgentStateRegistry {
  readonly #now: () => number;
  readonly #maxValueBytes: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<RegistryListener>();
  #modelEpoch: string;

  constructor(options: RegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#modelEpoch = options.modelEpoch ?? randomUUID();
  }

  currentModelEpoch(): string { return this.#modelEpoch; }

  /**
   * Host 重建或重新认证后开新代次。旧投影不能作为新代次的已确认事实，
   * 因此这里清空条目并广播 reset；来源要用完整清单重新建立基线。
   */
  beginModelEpoch(modelEpoch?: string): string {
    this.#modelEpoch = modelEpoch ?? randomUUID();
    this.#entries.clear();
    this.#emit({ kind: "reset", modelEpoch: this.#modelEpoch });
    return this.#modelEpoch;
  }

  /** 单值领域：整体替换当前投影。非 ready 的提交只更新核对状态，保留最后已知值。 */
  commitValue<T>(scope: StateScope, domain: StateDomain, fact: ValueFact<T>): CommitResult {
    const invalid = validateFact(fact);
    if (invalid !== undefined) return { ok: false, code: "invalid_fact", detail: invalid };
    const key = entryKey(scope, domain);
    const existing = this.#entries.get(key);
    const rejected = this.#reject(scope, domain, key, existing, fact);
    if (rejected !== undefined) return rejected;
    const previous = existing?.state.value ?? null;
    const next = fact.availability === "ready" ? fact.value ?? null : previous;
    return this.#store(scope, domain, key, existing, fact, next);
  }

  /**
   * 集合领域：`ready` + `complete` 时整份替换（缺席即删除）；`ready` + `partial` 时按 id 合并；
   * 其它情况保留最后已知集合，只更新可用性与核对时间。
   */
  commitCollection(scope: StateScope, domain: StateDomain, fact: CollectionFact): CommitResult {
    const invalid = validateFact(fact);
    if (invalid !== undefined) return { ok: false, code: "invalid_fact", detail: invalid };
    const key = entryKey(scope, domain);
    const existing = this.#entries.get(key);
    const rejected = this.#reject(scope, domain, key, existing, fact);
    if (rejected !== undefined) return rejected;
    const previous = (existing?.state.value ?? null) as Record<string, unknown> | null;
    const next = fact.availability !== "ready"
      ? previous
      : fact.completeness === "complete"
        ? { ...fact.items }
        : { ...(previous ?? {}), ...fact.items };
    return this.#store(scope, domain, key, existing, fact, next);
  }

  read<T>(scope: StateScope, domain: StateDomain): DomainState<T> | undefined {
    const entry = this.#entries.get(entryKey(scope, domain));
    return entry === undefined ? undefined : structuredClone(entry.state) as DomainState<T>;
  }

  /**
   * 基线读取契约：调用方带上自己已应用的版本，决定是「没变」「可直接应用」还是「必须重建基线」。
   * 只有 `ready` + `complete` 且有值的当前投影才自足；未知/部分/不可用都要回来源核对。
   */
  readForBaseline<T>(
    scope: StateScope,
    domain: StateDomain,
    known?: { readonly modelEpoch: string; readonly revision: number },
  ): BaselineRead<T> {
    const entry = this.#entries.get(entryKey(scope, domain));
    if (entry === undefined) return { action: "baseline", state: null };
    const state = structuredClone(entry.state) as DomainState<T>;
    if (known !== undefined && known.modelEpoch === state.modelEpoch && known.revision === state.revision) {
      return { action: "unchanged", state };
    }
    // ready + complete 才是自足的确认状态（value 为 null 表示「已确认没有内容」，不是未知）。
    const selfSufficient = state.availability === "ready" && state.completeness === "complete";
    return { action: selfSufficient ? "state" : "baseline", state };
  }

  /** 某个作用域当前的全部领域投影，用于快照发布。 */
  snapshot(scope: StateScope): Array<{ domain: StateDomain; state: DomainState<unknown> }> {
    const id = scopeId(scope);
    return [...this.#entries.values()]
      .filter(entry => scopeId(entry.scope) === id)
      .map(entry => ({ domain: entry.domain, state: structuredClone(entry.state) }));
  }

  /** 会话/接入确认结束后按作用域终结模型，不留旧写入者。 */
  endScope(scope: StateScope): number {
    const id = scopeId(scope);
    const removed = [...this.#entries.values()].filter(entry => scopeId(entry.scope) === id);
    for (const entry of removed) {
      this.#entries.delete(entryKey(entry.scope, entry.domain));
      this.#emit({ kind: "closed", scope: entry.scope, domain: entry.domain });
    }
    return removed.length;
  }

  subscribe(listener: RegistryListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  stats(): { modelEpoch: string; entries: number; writers: number } {
    return {
      modelEpoch: this.#modelEpoch,
      entries: this.#entries.size,
      writers: new Set([...this.#entries.values()].map(entry => entry.state.source.sourceId)).size,
    };
  }

  #reject(
    scope: StateScope,
    domain: StateDomain,
    key: string,
    existing: Entry | undefined,
    fact: DomainFact,
  ): CommitResult | undefined {
    if (fact.modelEpoch !== undefined && fact.modelEpoch !== this.#modelEpoch) {
      return { ok: false, code: "stale_model_epoch", detail: fact.modelEpoch };
    }
    if (existing === undefined) return undefined;
    if (existing.state.source.sourceId !== fact.source.sourceId || existing.state.source.producer !== fact.source.producer) {
      return { ok: false, code: "source_conflict", detail: scopeId(scope) + "/" + domain + " owned by " + existing.state.source.sourceId };
    }
    if (existing.state.source.sourceEpoch !== fact.source.sourceEpoch &&
      !(fact.availability === "ready" && fact.completeness === "complete")) {
      return { ok: false, code: "source_epoch_baseline_required" };
    }
    return undefined;
  }

  #store(
    scope: StateScope,
    domain: StateDomain,
    key: string,
    existing: Entry | undefined,
    fact: DomainFact,
    value: unknown,
  ): CommitResult {
    const fingerprint = JSON.stringify([fact.source, fact.availability, fact.completeness, value ?? null]);
    const bytes = byteLength(fingerprint);
    if (bytes > this.#maxValueBytes) {
      return { ok: false, code: "value_too_large", detail: bytes + " > " + this.#maxValueBytes };
    }
    if (existing === undefined && this.#entries.size >= this.#maxEntries) {
      return { ok: false, code: "registry_full" };
    }
    if (existing !== undefined && existing.fingerprint === fingerprint) {
      // 内容没变：只刷新核对时间，不推进版本，也不广播。
      existing.state = { ...existing.state, checkedAt: this.#now() };
      return { ok: true, revision: existing.state.revision, changed: false };
    }
    const revision = (existing?.state.revision ?? 0) + 1;
    const state: DomainState<unknown> = {
      modelEpoch: this.#modelEpoch,
      revision,
      availability: fact.availability,
      completeness: fact.completeness,
      source: fact.source,
      checkedAt: this.#now(),
      value: structuredClone(value ?? null),
    };
    this.#entries.set(key, { scope, domain, fingerprint, state });
    this.#emit({ kind: "committed", scope, domain, state: structuredClone(state) });
    return { ok: true, revision, changed: true };
  }

  #publishing = false;
  readonly #queue: RegistryChange[] = [];

  /**
   * 先提交再发布。已经是发布中（订阅者又触发了一次提交）时把变化排队，
   * 由当前这一轮统一按顺序发完，避免后来的订阅者看到交错顺序。
   */
  #emit(change: RegistryChange): void {
    this.#queue.push(change);
    if (this.#publishing) return;
    this.#publishing = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift() as RegistryChange;
        for (const listener of [...this.#listeners]) {
          try { listener(next); } catch { /* 订阅者不能破坏写者的事务 */ }
        }
      }
    } finally { this.#publishing = false; }
  }
}

function validateFact(fact: DomainFact): string | undefined {
  const { source, availability, completeness } = fact;
  if (source === undefined || typeof source.sourceId !== "string" || source.sourceId.trim() === "") return "source.sourceId";
  if (typeof source.sourceEpoch !== "string" || source.sourceEpoch.trim() === "") return "source.sourceEpoch";
  if (!Number.isSafeInteger(source.sourceRevision) || source.sourceRevision < 0) return "source.sourceRevision";
  if (source.producer !== "native" && source.producer !== "adapter" && source.producer !== "host") return "source.producer";
  if (availability !== "ready" && availability !== "unavailable" && availability !== "unknown") return "availability";
  if (completeness !== "complete" && completeness !== "partial" && completeness !== "unknown") return "completeness";
  return undefined;
}
