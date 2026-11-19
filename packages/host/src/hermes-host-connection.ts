import { HermesAgentBackend, type UnconfirmedHermesModel } from "./hermes-agent-backend.js";
import { connectHermesGateway, resolveHermesGatewayCommand, type HermesGatewayBootstrapOptions } from "./hermes-gateway-bootstrap.js";

type Slot = { backend: HermesAgentBackend; close: () => Promise<void> };

export type HermesHostOptions = Pick<HermesGatewayBootstrapOptions, "env" | "command" | "platform"> & {
  connect?: typeof connectHermesGateway;
};

/** A Host owns its socket, not the native Gateway or its sessions. */
export class HermesHostConnection {
  #slot: Slot | undefined;
  #connecting: Promise<HermesAgentBackend> | undefined;
  #profileId: string | undefined;
  #closed = false;
  #installed = false;
  readonly #env: NodeJS.ProcessEnv;
  readonly #modelFences = new Map<string, UnconfirmedHermesModel>();

  constructor(readonly options: HermesHostOptions, readonly hostId: string,
    readonly changed: (backend: HermesAgentBackend | undefined, retired?: HermesAgentBackend) => void) {
    this.#env = { ...(options.env ?? process.env) };
  }

  get installed(): boolean { return this.#installed; }
  get backend(): HermesAgentBackend | undefined { return this.#slot?.backend; }

  async discover(): Promise<void> {
    const command = this.options.command ?? await resolveHermesGatewayCommand(this.#env, this.options.platform).catch(() => undefined);
    if (command && !this.#closed && !this.#installed) {
      this.#installed = true;
      this.changed(this.backend);
    }
  }

  ensure(): Promise<HermesAgentBackend> {
    if (this.#closed) return Promise.reject(new Error("Host 已停止"));
    if (this.backend?.isReady()) return Promise.resolve(this.backend);
    if (this.#connecting) return this.#connecting;
    if (this.#slot) this.#retire(this.#slot);
    const attempt = this.#open();
    this.#connecting = attempt;
    void attempt.then(() => { this.#connecting = undefined; }, () => { this.#connecting = undefined; });
    return attempt;
  }

  async #open(): Promise<HermesAgentBackend> {
    let slot: Slot | undefined;
    const { connect = connectHermesGateway, ...options } = this.options;
    const { client, endpoint, runtime } = await connect({ ...options, env: this.#env,
      ...(this.#profileId === undefined ? {} : { expectedProfileId: this.#profileId }),
      onEvent: event => { if (slot && slot === this.#slot) void slot.backend.handleGatewayEvent(event); },
      onTransportError: () => { if (slot?.backend.isReady() === false) this.#retire(slot); },
    });
    if (this.#closed || client.closed || (this.#profileId !== undefined && this.#profileId !== endpoint.profile_id)) {
      await client.close();
      throw new Error("Hermes Gateway 已断开或 profile 已变化");
    }
    const backend = new HermesAgentBackend({ client, endpoint, runtime, hostId: this.hostId, modelFences: this.#modelFences });
    this.#profileId = endpoint.profile_id;
    this.#installed = true;
    this.#slot = slot = { backend, close: () => client.close() };
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
