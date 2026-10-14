import { randomUUID } from "node:crypto";

import type { AgentOperationItem, AgentOperationState, DeviceKey } from "@pi-remote/protocol";

import { AgentStateRegistry, type StateScope } from "./agent-state-registry.js";

/**
 * 设备视图的设备私有回执（ADR-0032 的 DeviceView.operations，模块 13）。
 *
 * 共享的「这个操作发生了什么」归 HostState.operations；这里只保存**发起设备**能看到的那一份，
 * 所以它写在设备作用域里，不广播给别的设备。回执有界：超过上限按最旧淘汰，并用显式的
 * 按 id 删除同步到模型，而不是靠「缺席」推断。
 */

const MAX_RECEIPTS_PER_DEVICE = 256;

export type DeviceViewFactsOptions = {
  readonly registry: AgentStateRegistry;
  readonly hostId: string;
  readonly now?: () => number;
};

export class DeviceViewFacts {
  readonly #registry: AgentStateRegistry;
  readonly #hostId: string;
  readonly #now: () => number;
  readonly #epoch = randomUUID();
  readonly #items = new Map<string, Map<string, AgentOperationItem>>();
  #revision = 0;

  constructor(options: DeviceViewFactsOptions) {
    this.#registry = options.registry;
    this.#hostId = options.hostId;
    this.#now = options.now ?? Date.now;
  }

  /** Host 受理了一个命令：先记「已接受」，后端结果到达后再覆盖。 */
  accepted(deviceId: string, operation: {
    readonly operationId: string;
    readonly runtimeId: string;
    readonly requestId?: string;
    readonly at?: number;
  }): void {
    this.#write(deviceId, {
      operationId: operation.operationId,
      runtimeId: operation.runtimeId,
      ...(operation.requestId === undefined ? {} : { requestId: operation.requestId }),
      state: "accepted",
      at: operation.at ?? this.#now(),
    });
  }

  /** 后端给了结果（或 Host 自己判定这个命令没能受理）。 */
  settled(deviceId: string, operation: {
    readonly operationId: string;
    readonly runtimeId: string;
    readonly state: AgentOperationState;
    readonly requestId?: string;
    readonly detail?: string;
    readonly at?: number;
  }): void {
    const known = this.#items.get(deviceId)?.get(operation.operationId);
    const requestId = operation.requestId ?? known?.requestId;
    this.#write(deviceId, {
      operationId: operation.operationId,
      runtimeId: operation.runtimeId,
      ...(requestId === undefined ? {} : { requestId }),
      state: operation.state,
      at: operation.at ?? this.#now(),
      ...(operation.detail === undefined ? {} : { detail: operation.detail.slice(0, 2_000) }),
    });
  }

  /** 设备被撤销/释放时终结它的视图，不留旧回执。 */
  forget(deviceId: string): number {
    this.#items.delete(deviceId);
    return this.#registry.endScope(this.#scope(deviceId));
  }

  read(deviceId: string): AgentOperationItem[] {
    return [...(this.#items.get(deviceId)?.values() ?? [])];
  }

  #write(deviceId: string, item: AgentOperationItem): void {
    try {
      const items = this.#items.get(deviceId) ?? new Map<string, AgentOperationItem>();
      this.#items.set(deviceId, items);
      // 同一操作只保留最新一条，并按插入顺序淘汰最旧的。
      items.delete(item.operationId);
      items.set(item.operationId, item);
      const evicted: string[] = [];
      while (items.size > MAX_RECEIPTS_PER_DEVICE) {
        const oldest = items.keys().next().value as string;
        items.delete(oldest);
        evicted.push(oldest);
      }
      this.#revision += 1;
      const source = {
        producer: "host" as const,
        sourceId: "host:device-operations",
        sourceEpoch: this.#epoch,
        sourceRevision: this.#revision,
      };
      this.#registry.commitCollection(this.#scope(deviceId), "operations", {
        source, availability: "ready", completeness: "partial",
        items: { [item.operationId]: item },
      });
      if (evicted.length > 0) {
        this.#registry.removeCollectionItems(this.#scope(deviceId), "operations", {
          source, availability: "ready", completeness: "partial", removeIds: evicted,
        });
      }
    } catch {
      // 记账失败绝不能影响命令与回执的正常投递。
    }
  }

  #scope(deviceId: string): StateScope {
    const key: DeviceKey = { hostId: this.#hostId, deviceId };
    return { kind: "device", key };
  }
}
