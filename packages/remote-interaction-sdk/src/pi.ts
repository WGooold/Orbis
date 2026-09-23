import type { InteractionRequest, InteractionResponse, RuntimeEvent } from "@pi-remote/protocol";
import {
  type ConfirmOptions,
  type InputOptions,
  type LocalInteractionUi,
  type MultiSelectOptions,
  type QuestionnaireOptions,
  type QuestionnaireAnswer,
  RemoteInteractionSdk,
  type SelectOptions,
} from "./index.js";

export const PI_REMOTE_BROKER_QUERY = "pi-remote:interaction-broker-query";

interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface PiLike {
  events: EventBusLike;
}

export interface PiInteractionContextLike {
  ui: {
    confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
    select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
    multiSelect?(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string[] | undefined>;
    input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  };
}

export interface InteractionCoordinator {
  readonly version: 1;
  coordinate<T>(extensionId: string, localUi: LocalInteractionUi | undefined, run: (sdk: RemoteInteractionSdk) => Promise<T>): Promise<T>;
}

/** Owned by the remote-control extension; request semantics remain in the SDK, not the Relay. */
export class InteractionBroker implements InteractionCoordinator {
  readonly version = 1 as const;
  readonly #runtimeId: string;
  readonly #publish: (event: RuntimeEvent) => void;
  readonly #onActiveChange: ((active: boolean) => void) | undefined;
  readonly #active = new Set<RemoteInteractionSdk>();

  constructor(
    runtimeId: string,
    publish: (event: RuntimeEvent) => void,
    onActiveChange?: (active: boolean) => void,
  ) {
    this.#runtimeId = runtimeId;
    this.#publish = publish;
    this.#onActiveChange = onActiveChange;
  }

  get hasActiveInteractions(): boolean {
    return this.#active.size > 0;
  }

  async coordinate<T>(
    extensionId: string,
    localUi: LocalInteractionUi | undefined,
    run: (sdk: RemoteInteractionSdk) => Promise<T>,
  ): Promise<T> {
    const sdk = new RemoteInteractionSdk({
      runtimeId: this.#runtimeId,
      extensionId,
      ...(localUi === undefined ? {} : { localUi }),
      publish: this.#publish,
    });
    this.#active.add(sdk);
    this.#onActiveChange?.(true);
    try {
      return await run(sdk);
    } finally {
      sdk.close();
      this.#active.delete(sdk);
      this.#onActiveChange?.(this.#active.size > 0);
    }
  }

  respond(requestId: string, extensionId: string, response: InteractionResponse): boolean {
    for (const sdk of this.#active) {
      if (sdk.respond({ runtimeId: this.#runtimeId, requestId, extensionId, response })) return true;
    }
    return false;
  }

  /** A transport loss is recoverable and must not reject the Pi request. */
  disconnected(): void {
    for (const sdk of this.#active) sdk.remoteDisconnected();
  }

  /** The owning Pi bridge is closing; pending requests are terminal now. */
  closed(): void {
    for (const sdk of this.#active) sdk.close();
  }

  resync(): void {
    this.#publish({
      type: "interaction.snapshot",
      requests: [...this.#active].flatMap((sdk) => sdk.pendingRequests()),
    });
    for (const sdk of this.#active) sdk.republishPending(false);
  }

  close(): void {
    this.closed();
    this.#active.clear();
    this.#onActiveChange?.(false);
  }
}

const confirmDescription = (request: Extract<InteractionRequest, { kind: "confirm" }>): string => {
  const context = [
    request.toolName ? `Tool: ${request.toolName}` : undefined,
    request.argumentSummary ? `Arguments: ${request.argumentSummary}` : undefined,
  ].filter((line): line is string => line !== undefined).join("\n");
  return [context, request.description].filter((section): section is string => Boolean(section)).join("\n\n");
};

const localUiFor = (ctx: PiInteractionContextLike): LocalInteractionUi => ({
  confirm: (request, signal) => ctx.ui.confirm(request.title, confirmDescription(request), { signal }),
  async select(request, signal) {
    const rendered = request.options.map((option, index) =>
      `${option.label}${option.description ? ` — ${option.description}` : ""} [${index + 1}]`
    );
    const selected = await ctx.ui.select(request.title, rendered, { signal });
    const index = selected === undefined ? -1 : rendered.indexOf(selected);
    return index < 0 ? undefined : request.options[index]?.value;
  },
  // Pi's shared UI has no native multi-select, so a local-only responder walks
  // the options with confirm prompts. The desktop `ask_user_question` panel does
  // not use this path; it renders its own local multi-select UI.
  async multiSelect(request, signal) {
    const selected: string[] = [];
    for (const option of request.options) {
      const confirmed = await ctx.ui.confirm(
        request.title,
        [
          request.description,
          `${option.label}${option.description ? ` — ${option.description}` : ""}`,
        ].filter((section): section is string => Boolean(section)).join("\n\n"),
        { signal },
      );
      if (confirmed) selected.push(option.value);
    }
    return selected;
  },
  input: (request, signal) => ctx.ui.input(
    request.title,
    request.placeholder ?? request.initialValue,
    { signal },
  ),
});

const findBroker = (pi: PiLike): InteractionCoordinator | undefined => {
  const query: { broker?: InteractionCoordinator } = {};
  pi.events.emit(PI_REMOTE_BROKER_QUERY, query);
  return query.broker?.version === 1 ? query.broker : undefined;
};

export interface PiRemoteInteractionClient {
  confirm(ctx: PiInteractionContextLike, options: ConfirmOptions): Promise<boolean>;
  select(ctx: PiInteractionContextLike, options: SelectOptions): Promise<string>;
  multiSelect(ctx: PiInteractionContextLike, options: MultiSelectOptions): Promise<string[]>;
  input(ctx: PiInteractionContextLike, options: InputOptions): Promise<string>;
  questionnaire(options: QuestionnaireOptions, localUi?: LocalInteractionUi): Promise<QuestionnaireAnswer[]>;
}

/** Recommended third-party extension interface. It never exposes Relay protocol or credentials. */
export function createPiRemoteInteraction(pi: PiLike, extensionId: string): PiRemoteInteractionClient {
  if (!extensionId.trim()) throw new Error("extensionId is required");

  const coordinate = <T>(
    ctx: PiInteractionContextLike,
    run: (sdk: RemoteInteractionSdk) => Promise<T>,
  ): Promise<T> => {
    const broker = findBroker(pi) ?? new InteractionBroker("local-only", () => undefined);
    return broker.coordinate(extensionId, localUiFor(ctx), run);
  };

  return {
    confirm: (ctx, options) => coordinate(ctx, (sdk) => sdk.confirm(options)),
    select: (ctx, options) => coordinate(ctx, (sdk) => sdk.select(options)),
    multiSelect: (ctx, options) => coordinate(ctx, (sdk) => sdk.multiSelect(options)),
    input: (ctx, options) => coordinate(ctx, (sdk) => sdk.input(options)),
    questionnaire: (options, localUi) => {
      const broker = findBroker(pi);
      if (!broker && !localUi?.questionnaire) {
        return Promise.reject(new Error("Questionnaire requires a remote broker or a local questionnaire UI"));
      }
      return (broker ?? new InteractionBroker("local-only", () => undefined))
        .coordinate(extensionId, localUi, (sdk) => sdk.questionnaire(options));
    },
  };
}
