import { randomUUID } from "node:crypto";

import type { HostCatalogState, HostProvidersState } from "@pi-remote/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";

/**
 * Host 级共享领域的写入器（ADR-0032 的 HostState）。
 *
 * 目前只有聚合目录：它记录**每个后端各自的读取结果与完整性**，这样「某个后端拉取失败」
 * 在模型里不会退化成「那个后端没有会话」——ADR-0032 明确要求失败不当作完整空目录。
 */

export type HostStateFactsOptions = {
  readonly registry: AgentStateRegistry;
  readonly now?: () => number;
};

export class HostStateFacts {
  readonly #registry: AgentStateRegistry;
  readonly #now: () => number;
  readonly #epoch = randomUUID();
  #revision = 0;

  constructor(options: HostStateFactsOptions) {
    this.#registry = options.registry;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 记录一次目录聚合。
   *
   * 只要有一个后端没读全，整个目录就不是完整清单，因此 `completeness` 只能是 partial：
   * 客户端据此知道「这里少了东西」，而不是把缺席的会话当成已删除。
   */
  catalog(state: Omit<HostCatalogState, "checkedAt">): void {
    try {
      const complete = state.backends.every(backend => backend.complete) && !state.truncated;
      this.#revision += 1;
      this.#registry.commitValue(this.#scope(), "catalog", {
        source: {
          producer: "host",
          sourceId: "host:catalog",
          sourceEpoch: this.#epoch,
          sourceRevision: this.#revision,
        },
        availability: "ready",
        completeness: complete ? "complete" : "partial",
        value: { ...state, checkedAt: this.#now() } satisfies HostCatalogState,
      });
    } catch {
      // 记账失败不影响会话目录的正常返回。
    }
  }

  /**
   * 记录供应商公共投影（模块 20–22）。
   *
   * 与目录不同，这里没有「完整清单」的概念：某个后端没报摘要就是它缺席，客户端按 `unknown`
   * 处理，而不是把缺席当成「这台电脑没有供应商」。
   */
  providers(state: Omit<HostProvidersState, "checkedAt">): void {
    try {
      this.#revision += 1;
      this.#registry.commitValue(this.#scope(), "providers", {
        source: {
          producer: "host",
          sourceId: "host:providers",
          sourceEpoch: this.#epoch,
          sourceRevision: this.#revision,
        },
        availability: state.providers.length === 0 ? "unknown" : "ready",
        completeness: "partial",
        value: { ...state, checkedAt: this.#now() } satisfies HostProvidersState,
      });
    } catch {
      // 记账失败不影响供应商命令本身的返回。
    }
  }

  /** 供 Host 内部与测试读取当前供应商投影。 */
  readProviders(): HostProvidersState | undefined {
    return this.#registry.read<HostProvidersState>(this.#scope(), "providers")?.value ?? undefined;
  }

  #scope(): StateScope {
    return { kind: "host" };
  }

  /** 供 Host 内部与测试读取当前目录模型。 */
  read(): HostCatalogState | undefined {
    return this.#registry.read<HostCatalogState>(this.#scope(), "catalog")?.value ?? undefined;
  }
}
