import { randomUUID } from "node:crypto";
import {
  InteractionRequestSchema,
  QuestionnaireAnswerSchema,
  type InteractionRequest,
  type InteractionResponse,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
  type RuntimeEvent,
} from "@pi-remote/protocol";
export type { QuestionnaireAnswer, QuestionnaireQuestion } from "@pi-remote/protocol";

type InteractionValue = boolean | string | string[] | QuestionnaireAnswer[];
const responseValue = (response: Exclude<InteractionResponse, { kind: "cancel" }>): InteractionValue =>
  response.kind === "questionnaire" ? response.answers : response.kind === "multi-select" ? response.values : response.value;

export type InteractionErrorCode = "cancelled" | "timeout" | "disconnected" | "owner_closed";

export class RemoteInteractionError extends Error {
  readonly code: InteractionErrorCode;

  constructor(code: InteractionErrorCode) {
    super(`Remote interaction ${code}`);
    this.name = "RemoteInteractionError";
    this.code = code;
  }
}

export interface LocalInteractionUi {
  confirm(request: Extract<InteractionRequest, { kind: "confirm" }>, signal: AbortSignal): Promise<boolean>;
  select(request: Extract<InteractionRequest, { kind: "select" }>, signal: AbortSignal): Promise<string | undefined>;
  multiSelect(request: Extract<InteractionRequest, { kind: "multi-select" }>, signal: AbortSignal): Promise<string[] | undefined>;
  input(request: Extract<InteractionRequest, { kind: "input" }>, signal: AbortSignal): Promise<string | undefined>;
  questionnaire?(request: Extract<InteractionRequest, { kind: "questionnaire" }>, signal: AbortSignal): Promise<QuestionnaireAnswer[] | undefined>;
}

interface CommonOptions {
  title: string;
  description?: string;
  toolName?: string;
  argumentSummary?: string;
  /**
   * Request lifetime in milliseconds. Omit to use the SDK default, or pass
   * `null` to keep the request pending until a responder answers it or the
   * owning turn/session is closed.
   */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export interface ConfirmOptions extends CommonOptions {
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface SelectOptions extends CommonOptions {
  options: Array<{ value: string; label: string; description?: string }>;
}

export interface MultiSelectOptions extends CommonOptions {
  options: Array<{ value: string; label: string; description?: string }>;
  minSelections?: number;
  maxSelections?: number;
}

export interface QuestionnaireOptions extends CommonOptions {
  questions: QuestionnaireQuestion[];
}

export interface InputOptions extends CommonOptions {
  placeholder?: string;
  initialValue?: string;
  minLength?: number;
  maxLength?: number;
  secret?: boolean;
}

export interface RemoteResponseEnvelope {
  runtimeId: string;
  requestId: string;
  extensionId: string;
  response: InteractionResponse;
}

export interface RemoteInteractionSdkOptions {
  runtimeId: string;
  extensionId: string;
  localUi?: LocalInteractionUi;
  publish(event: RuntimeEvent): void;
  defaultTimeoutMs?: number;
  createId?: () => string;
}

type Pending = {
  request: InteractionRequest;
  resolve: (value: InteractionValue) => void;
  reject: (error: RemoteInteractionError) => void;
  localController: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeExternalAbort?: () => void;
};

/**
 * `expiresAt` sentinel for requests that never time out. The Relay protocol
 * requires a positive integer `expiresAt`, so a request without a timeout must
 * still carry a value that no real clock reaches. It also stays inside the
 * safe-integer range that Zod (`.int()`) and JSON can represent exactly.
 */
const NO_TIMEOUT_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

/** Coordinates one extension's structured prompts across local and remote responders. */
export class RemoteInteractionSdk {
  readonly #options: RemoteInteractionSdkOptions;
  readonly #pending = new Map<string, Pending>();

  constructor(options: RemoteInteractionSdkOptions) {
    this.#options = options;
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    const request = this.#request("confirm", options, {
      ...(options.confirmLabel === undefined ? {} : { confirmLabel: options.confirmLabel }),
      ...(options.cancelLabel === undefined ? {} : { cancelLabel: options.cancelLabel }),
    });
    return this.#open(request, options.signal) as Promise<boolean>;
  }

  select(options: SelectOptions): Promise<string> {
    if (options.options.length === 0) throw new Error("select requires at least one option");
    const request = this.#request("select", options, { options: options.options });
    return this.#open(request, options.signal) as Promise<string>;
  }

  multiSelect(options: MultiSelectOptions): Promise<string[]> {
    if (options.options.length === 0) throw new Error("multiSelect requires at least one option");
    if (
      options.minSelections !== undefined &&
      options.maxSelections !== undefined &&
      options.minSelections > options.maxSelections
    ) {
      throw new Error("multiSelect minSelections cannot exceed maxSelections");
    }
    const request = this.#request("multi-select", options, {
      options: options.options,
      ...(options.minSelections === undefined ? {} : { minSelections: options.minSelections }),
      ...(options.maxSelections === undefined ? {} : { maxSelections: options.maxSelections }),
    });
    return this.#open(request, options.signal) as Promise<string[]>;
  }

  input(options: InputOptions): Promise<string> {
    if (options.minLength !== undefined && options.maxLength !== undefined && options.minLength > options.maxLength) {
      throw new Error("input minLength cannot exceed maxLength");
    }
    const request = this.#request("input", options, {
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      ...(options.minLength === undefined ? {} : { minLength: options.minLength }),
      ...(options.maxLength === undefined ? {} : { maxLength: options.maxLength }),
      ...(options.secret === undefined ? {} : { secret: options.secret }),
    });
    return this.#open(request, options.signal) as Promise<string>;
  }

  /** One request owns the entire form; only a complete, valid submission resolves it. */
  questionnaire(options: QuestionnaireOptions): Promise<QuestionnaireAnswer[]> {
    const request = this.#request("questionnaire", options, { questions: options.questions });
    InteractionRequestSchema.parse(request);
    if (new Set(options.questions.map((question) => question.id)).size !== options.questions.length ||
      options.questions.some((question) => new Set(question.options.map((option) => option.value)).size !== question.options.length)) {
      throw new Error("Question and option IDs must be unique");
    }
    return this.#open(request, options.signal) as Promise<QuestionnaireAnswer[]>;
  }

  respond(envelope: RemoteResponseEnvelope): boolean {
    if (envelope.runtimeId !== this.#options.runtimeId || envelope.extensionId !== this.#options.extensionId) {
      return false;
    }
    const pending = this.#pending.get(envelope.requestId);
    if (!pending) return false;
    if (envelope.response.kind === "cancel") {
      this.#reject(pending, "cancelled");
      return true;
    }
    if (!this.#validResponse(pending.request, envelope.response)) return false;
    this.#resolve(pending, responseValue(envelope.response), "remote");
    return true;
  }

  cancel(requestId: string): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#reject(pending, "cancelled");
    return true;
  }

  /**
   * A lost phone/Relay path is recoverable. Keep the Pi promise and pending request
   * alive; the next transport resync will publish the same requestId again.
   */
  remoteDisconnected(): void {
    // Kept as an explicit lifecycle hook for transports. There is deliberately no
    // rejection here: a transport disconnect is not a user cancellation.
  }

  pendingRequests(): InteractionRequest[] {
    return [...this.#pending.values()].map((pending) => pending.request);
  }

  republishPending(includeSnapshot = true): void {
    if (includeSnapshot) {
      this.#options.publish({ type: "interaction.snapshot", requests: this.pendingRequests() });
    }
    for (const pending of this.#pending.values()) {
      this.#options.publish({ type: "interaction.requested", request: pending.request });
    }
  }

  /** The owning Pi turn/session is ending; this is terminal for its requests. */
  close(): void {
    for (const pending of [...this.#pending.values()]) this.#reject(pending, "owner_closed");
  }

  #request<K extends InteractionRequest["kind"]>(
    kind: K,
    options: CommonOptions,
    details: Record<string, unknown>,
  ): Extract<InteractionRequest, { kind: K }> {
    const timeoutMs = options.timeoutMs === null
      ? null
      : options.timeoutMs ?? this.#options.defaultTimeoutMs ?? 60_000;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("timeoutMs must be positive");
    }
    return {
      runtimeId: this.#options.runtimeId,
      requestId: this.#options.createId?.() ?? randomUUID(),
      extensionId: this.#options.extensionId,
      kind,
      title: options.title,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.toolName === undefined ? {} : { toolName: options.toolName }),
      ...(options.argumentSummary === undefined ? {} : { argumentSummary: options.argumentSummary }),
      expiresAt: timeoutMs === null ? NO_TIMEOUT_EXPIRES_AT : Date.now() + timeoutMs,
      ...details,
    } as Extract<InteractionRequest, { kind: K }>;
  }

  #open(request: InteractionRequest, externalSignal?: AbortSignal): Promise<InteractionValue> {
    if (externalSignal?.aborted) return Promise.reject(new RemoteInteractionError("cancelled"));
    if (this.#pending.has(request.requestId)) throw new Error(`Duplicate interaction request id: ${request.requestId}`);

    let pending!: Pending;
    const result = new Promise<InteractionValue>((resolve, reject) => {
      const localController = new AbortController();
      // Node clamps setTimeout delays above 2^31 - 1 ms by firing immediately, so a
      // request without a timeout must skip the timer instead of passing a large value.
      const timer = request.expiresAt >= NO_TIMEOUT_EXPIRES_AT
        ? undefined
        : setTimeout(() => this.#reject(pending, "timeout"), Math.max(0, request.expiresAt - Date.now()));
      timer?.unref?.();
      pending = { request, resolve, reject, localController, timer };
      if (externalSignal) {
        const abort = () => this.#reject(pending, "cancelled");
        externalSignal.addEventListener("abort", abort, { once: true });
        pending.removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
      }
      this.#pending.set(request.requestId, pending);
    });

    this.#options.publish({ type: "interaction.requested", request });
    this.#startLocal(pending);
    return result;
  }

  #startLocal(pending: Pending): void {
    const ui = this.#options.localUi;
    if (!ui) return;
    // A primitive-only desktop adapter must not cancel a phone questionnaire.
    if (pending.request.kind === "questionnaire" && !ui.questionnaire) return;
    const answer = async (): Promise<InteractionResponse | undefined> => {
      const request = pending.request;
      const signal = pending.localController.signal;
      switch (request.kind) {
        case "confirm": return { kind: "confirm", value: await ui.confirm(request, signal) };
        case "select": {
          const value = await ui.select(request, signal);
          return value === undefined ? undefined : { kind: "select", value };
        }
        case "multi-select": {
          const values = await ui.multiSelect(request, signal);
          return values === undefined ? undefined : { kind: "multi-select", values };
        }
        case "input": {
          const value = await ui.input(request, signal);
          return value === undefined ? undefined : { kind: "input", value };
        }
        case "questionnaire": {
          const answers = await ui.questionnaire!(request, signal);
          return answers === undefined ? undefined : { kind: "questionnaire", answers };
        }
      }
    };
    void answer().then((response) => {
      if (!this.#pending.has(pending.request.requestId)) return;
      if (!response || response.kind === "cancel" || !this.#validResponse(pending.request, response)) {
        this.#reject(pending, "cancelled");
      } else this.#resolve(pending, responseValue(response), "local");
    }).catch(() => {
      if (this.#pending.has(pending.request.requestId)) this.#reject(pending, "cancelled");
    });
  }

  #validResponse(request: InteractionRequest, response: InteractionResponse): boolean {
    if (request.kind !== response.kind) return false;
    if (response.kind === "confirm") return typeof response.value === "boolean";
    if (request.kind === "select" && response.kind === "select") {
      return request.options.some((option) => option.value === response.value);
    }
    if (request.kind === "multi-select" && response.kind === "multi-select") {
      const allowed = new Set(request.options.map((option) => option.value));
      if (new Set(response.values).size !== response.values.length) return false;
      if (!response.values.every((value) => allowed.has(value))) return false;
      if (request.minSelections !== undefined && response.values.length < request.minSelections) return false;
      if (request.maxSelections !== undefined && response.values.length > request.maxSelections) return false;
      return true;
    }
    if (request.kind === "questionnaire" && response.kind === "questionnaire") {
      if (response.answers.length !== request.questions.length) return false;
      const byId = new Map(response.answers.map((answer) => [answer.id, answer]));
      if (byId.size !== response.answers.length) return false;
      return request.questions.every((question) => {
        const answer = byId.get(question.id);
        if (!answer || !QuestionnaireAnswerSchema.safeParse(answer).success) return false;
        const allowed = new Set(question.options.map((option) => option.value));
        if (new Set(answer.values).size !== answer.values.length || !answer.values.every((value) => allowed.has(value))) return false;
        if (answer.other !== undefined && (!question.allowOther || !answer.other.trim())) return false;
        if (answer.notes !== undefined && !question.allowNotes) return false;
        const count = answer.values.length + (answer.other?.trim() ? 1 : 0);
        return count > 0 && (question.multiSelect === true || count === 1);
      });
    }
    if (request.kind === "input" && response.kind === "input") {
      if (typeof response.value !== "string") return false;
      if (request.minLength !== undefined && response.value.length < request.minLength) return false;
      if (request.maxLength !== undefined && response.value.length > request.maxLength) return false;
    }
    return true;
  }

  #resolve(pending: Pending, value: InteractionValue, source: "local" | "remote"): void {
    if (!this.#take(pending)) return;
    this.#options.publish({ type: "interaction.resolved", requestId: pending.request.requestId, source });
    pending.resolve(value);
  }

  #reject(pending: Pending, code: InteractionErrorCode): void {
    if (!this.#take(pending)) return;
    this.#options.publish({
      type: "interaction.cancelled",
      requestId: pending.request.requestId,
      reason: code,
    });
    pending.reject(new RemoteInteractionError(code));
  }

  #take(pending: Pending): boolean {
    if (this.#pending.get(pending.request.requestId) !== pending) return false;
    this.#pending.delete(pending.request.requestId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.removeExternalAbort?.();
    pending.localController.abort();
    return true;
  }
}

export {
  createPiRemoteInteraction,
  InteractionBroker,
  PI_REMOTE_BROKER_QUERY,
} from "./pi.js";
export type {
  InteractionCoordinator,
  PiInteractionContextLike,
  PiRemoteInteractionClient,
} from "./pi.js";
