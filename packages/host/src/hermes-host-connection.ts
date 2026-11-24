import { HermesAgentBackend, type UnconfirmedHermesModel } from "./hermes-agent-backend.js";
import { connectHermesGateway, resolveHermesGatewayCommand, type HermesGatewayBootstrapOptions } from "./hermes-gateway-bootstrap.js";
import type { HermesRemoteGatewayConfig } from "./hermes-remote-gateway.js";

type Slot = { backend: HermesAgentBackend; close: () => Promise<void> };
const alwaysCurrent = () => true;

export type HermesHostOptions = Pick<HermesGatewayBootstrapOptions, "env" | "command" | "platform"> & {
  getRemoteGateway?: () => Promise<HermesRemoteGatewayConfig | undefined>;
  connect?: typeof connectHermesGateway;
  onRuntimeOffline?: (runtimeId: string, reason: string) => void;
};

/** A Host owns its socket, not the native Gateway or its sessions. */
export class HermesHostConnection {
  #slot: Slot | undefined;
  #connecting: Promise<HermesAgentBackend> | undefined;
  #attaching: Promise<HermesAgentBackend> | undefined;
  #profileId: string | undefined;
  #connectionScope: string | undefined;
  #closed = false;
  #installed = false;
  #local = false;
  readonly #startRequests = new Set<() => boolean>();
  readonly #env: NodeJS.ProcessEnv;
  readonly #modelFences = new Map<string, UnconfirmedHermesModel>();

  constructor(readonly options: HermesHostOptions, readonly hostId: string,
    readonly changed: (backend: HermesAgentBackend | undefined, retired?: HermesAgentBackend) => void,
    readonly progress: () => void = () => {}) {
    this.#env = { ...(options.env ?? process.env) };
  }

  get installed(): boolean { return this.#installed; }
  get starting(): boolean { return this.#connecting !== undefined; }
  get backend(): HermesAgentBackend | undefined { return this.#slot?.backend; }

  async discover(): Promise<void> {
    const remote = await this.options.getRemoteGateway?.();
    this.#local = remote === undefined;
    if (remote && !this.#closed && !this.#installed) {
      this.#installed = true;
      this.changed(this.backend);
      return;
    }
    const command = this.options.command ?? await resolveHermesGatewayCommand(this.#env, this.options.platform).catch(() => undefined);
    if (command && !this.#closed && !this.#installed) {
      this.#installed = true;
      this.changed(this.backend);
    }
  }

  ensure(current = alwaysCurrent, localOnly = false): Promise<HermesAgentBackend> {
    if (this.#closed || !current()) return Promise.reject(new Error("Hermes 接入已取消"));
    if (localOnly && !this.#local && (this.#slot || this.#connecting || this.#attaching))
      return Promise.reject(new Error("远程 Hermes Gateway 只接入已有服务"));
    if (this.backend?.isReady()) return Promise.resolve(this.backend);
    if (!this.#connecting && this.#attaching) return this.#attaching.then(backend => {
      if (!current()) throw new Error("Hermes 接入已取消");
      return backend;
    }, () => this.ensure(current, localOnly));
    const request = () => current();
    this.#startRequests.add(request);
    if (!this.#connecting) {
      if (this.#slot) this.#retire(this.#slot);
      this.#connecting = this.#open(false, localOnly).finally(() => {
        this.#connecting = undefined;
        this.#startRequests.clear();
        if (!this.#closed) this.progress();
      });
      this.progress();
    }
    if (current === alwaysCurrent) return this.#connecting;
    return this.#connecting.then(backend => {
      if (!current()) throw new Error("Hermes 接入已取消");
      return backend;
    }).finally(() => { this.#startRequests.delete(request); });
  }

  attachExisting(): Promise<HermesAgentBackend> {
    if (this.#closed) return Promise.reject(new Error("Host 已停止"));
    if (this.backend?.isReady()) return Promise.resolve(this.backend);
    if (this.#connecting) return this.#connecting;
    if (this.#attaching) return this.#attaching;
    if (this.#slot) this.#retire(this.#slot);
    const attempt = this.#open(true);
    this.#attaching = attempt;
    void attempt.then(() => { this.#attaching = undefined; }, () => { this.#attaching = undefined; });
    return attempt;
  }

  async #open(existingOnly: boolean, localOnly = false): Promise<HermesAgentBackend> {
    let slot: Slot | undefined;
    const { connect = connectHermesGateway, getRemoteGateway, ...options } = this.options;
    const remoteGateway = getRemoteGateway ? await getRemoteGateway() : undefined;
    if (localOnly && remoteGateway) throw new Error("远程 Hermes Gateway 只接入已有服务");
    this.#local = remoteGateway === undefined;
    const requireCurrent = () => {
      if (this.#closed || !existingOnly && ![...this.#startRequests].some(valid => valid())) throw new Error("Hermes 接入已取消");
    };
    requireCurrent();
    const scope = remoteGateway
      ? JSON.stringify(["ssh", remoteGateway.host, remoteGateway.port, remoteGateway.profile ?? ""])
      : "local";
    if (this.#connectionScope !== undefined && this.#connectionScope !== scope) this.#profileId = undefined;
    this.#connectionScope = scope;
    const attachment = await connect({ ...options, env: this.#env, existingOnly, requireCurrent, ...(remoteGateway ? { remoteGateway } : {}),
      ...(this.#profileId === undefined ? {} : { expectedProfileId: this.#profileId }),
      onEvent: event => { if (slot && slot === this.#slot) void slot.backend.handleGatewayEvent(event); },
      onTransportError: () => { if (slot?.backend.isReady() === false) this.#retire(slot); },
    });
    const close = async () => {
      await attachment.client.close().catch(() => undefined);
      await attachment.close?.().catch(() => undefined);
    };
    if (this.#closed || attachment.client.closed ||
        (this.#profileId !== undefined && this.#profileId !== attachment.endpoint.profile_id)) {
      await close();
      throw new Error("Hermes Gateway 已断开或 profile 已变化");
    }
    const backend = new HermesAgentBackend({ client: attachment.client, endpoint: attachment.endpoint, runtime: attachment.runtime,
      hostId: this.hostId, modelFences: this.#modelFences,
      ...(this.options.onRuntimeOffline ? { onRuntimeOffline: this.options.onRuntimeOffline } : {}) });
    this.#profileId = attachment.endpoint.profile_id;
    this.#installed = true;
    this.#slot = slot = { backend, close };
    this.changed(backend);
    return backend;
  }

  #retire(slot: Slot): void {
    if (this.#slot !== slot) return;
    this.#slot = undefined;
    slot.backend.setEventSink(() => undefined);
    if (!this.#closed) this.changed(undefined, slot.backend);
    void slot.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const slot = this.#slot;
    if (!slot) return; // A late bootstrap reply closes its socket in #open, without blocking Host pause.
    this.#slot = undefined;
    slot.backend.setEventSink(() => undefined);
    await slot.close();
  }
}
