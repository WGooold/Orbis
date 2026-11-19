import {
  DISPLAY_PROJECTION_VERSION, LEGACY_DISPLAY_PROJECTION_VERSION, downgradeMessageForLegacy,
  normalizeCodexMessage, projectDisplayEntries, renderStreamingMarkdown, hasCitationSuffix, hasCodexDirective,
  type ChatMessage, type RemoteSessionEntry, type RuntimeEvent,
} from "@orbis/protocol";
import { MessageFileReferences } from "./message-file-references.js";

const maxStreams = 64;
const maxStreamLength = 256 * 1024;
type JsonObject = Record<string, unknown>;
type Stream = { raw: string; visible: string; pending: boolean; excessive?: true };
type Projection = { rich: boolean; codex: boolean; cwd?: string; generatedImagePath?: (messageId: string) => string | undefined };

/** The source retains canonical entries. This adapter only projects the device wire view. */
export class DeviceMessageRendering {
  readonly #files: MessageFileReferences;
  readonly #previews = new WeakMap<RuntimeEvent, RuntimeEvent>();
  readonly #streams = new Map<string, Stream>();
  readonly #history = new WeakMap<object, Map<string, RuntimeEvent>>();

  constructor(files: MessageFileReferences) { this.#files = files; }

  /** Observe the source once, even when no phone is subscribed to the conversation. */
  observe(runtimeId: string, event: RuntimeEvent): void {
    switch (event.type) {
      case "message.started": {
        if (event.message.role !== "assistant") break;
        const text = event.message.content[0];
        const raw = text?.type === "text" ? text.text : "";
        const visible = renderStreamingMarkdown(raw);
        this.#setStream(`${runtimeId}\0${event.message.messageId}`, { raw, visible: visible.text, pending: visible.pending });
        if (text?.type === "text" && text.text !== visible.text) this.#previews.set(event, { ...event, message: {
          ...event.message, content: [{ ...text, text: visible.text }, ...event.message.content.slice(1)],
        } });
        break;
      }
      case "message.delta":
        this.#previews.set(event, this.#delta(runtimeId, event));
        break;
      case "message.finished":
        this.#streams.delete(`${runtimeId}\0${event.message.messageId}`);
        break;
      case "turn.finished":
        this.releaseRuntime(runtimeId);
        break;
    }
  }

  project(deviceId: string, message: object, options: Projection): object {
    const envelope = object(message);
    if (envelope?.type !== "runtime.event" || !object(envelope.event)) return message;
    const event = envelope.event as RuntimeEvent;
    const runtimeId = String(envelope.runtimeId);
    const resolve = (path: string) => options.rich ? this.#files.register(path, options.cwd, deviceId, runtimeId) : undefined;
    const project = (value: ChatMessage, streaming = false): ChatMessage => {
      const normalized = options.codex ? normalizeCodexMessage(value, resolve, streaming) : value;
      if (!options.rich) return downgradeMessageForLegacy(normalized);
      if (streaming || !options.generatedImagePath || !normalized.content.some(block => block.type === "render" && block.renderKind === "codex_generated_image")) return normalized;
      const path = options.generatedImagePath(normalized.messageId);
      const name = path?.split(/[\\/]/u).at(-1);
      if (!path || !name || name.length > 255 || Array.from(path).some(ch => ch.codePointAt(0)! < 32 || /[\u007f\u202a-\u202e\u2066-\u2069]/u.test(ch))) return normalized;
      const file = resolve(path);
      if (!file) return normalized;
      return { ...normalized, content: normalized.content.map(block => block.type === "render" && block.renderKind === "codex_generated_image"
        ? { type: "render", renderKind: "file_reference", purpose: "output", text: name, file: { fileName: name, referenceId: file.referenceId } }
        : block) };
    };
    let next: RuntimeEvent = event;
    switch (event.type) {
      case "message.started":
      case "message.finished": {
        const preview = event.type === "message.started" ? this.#previews.get(event) : undefined;
        if (preview?.type === "message.started") { next = preview; break; }
        const rendered = project(event.message, event.type === "message.started");
        if (rendered !== event.message) next = { ...event, message: rendered };
        break;
      }
      case "message.delta":
        next = this.#previews.get(event) ?? event;
        break;
      case "session.snapshot":
      case "session.patch": {
        const cacheKey = JSON.stringify([deviceId, options.rich, options.codex, options.cwd ?? null]);
        const cached = this.#history.get(event)?.get(cacheKey);
        if (cached) { next = cached; break; }
        const display = event.display;
        if (display && ![DISPLAY_PROJECTION_VERSION, LEGACY_DISPLAY_PROJECTION_VERSION].includes(display.projectionVersion)) break;
        // Rebuild released adapter projections from the same canonical batch where available.
        // The producer still owns ordering, visibility, and compaction anchors.
        const entries = new Map(event.entries?.map(entry => [entry.entryId, entry]));
        const batch = display && {
          ...display, projectionVersion: options.rich ? DISPLAY_PROJECTION_VERSION : LEGACY_DISPLAY_PROJECTION_VERSION,
          entries: display.entries.map(row => {
            if (!row.message) return row;
            const native = row.entryId === null ? undefined : entries.get(row.entryId);
            const message = native && display.projectionVersion === LEGACY_DISPLAY_PROJECTION_VERSION && hasSpecialBlock(native)
              ? projectEntry(native) ?? row.message : row.message;
            const rendered = project(message);
            return rendered === row.message ? row : { ...row, message: rendered };
          }),
        };
        const live = event.live && { ...event.live, messages: event.live.messages.map(item => ({ ...item, message: project(item.message, !item.finished) })) };
        next = { ...event, ...(batch ? { display: batch } : {}), ...(live ? { live } : {}) } as typeof event;
        const variants = this.#history.get(event) ?? new Map<string, RuntimeEvent>();
        variants.set(cacheKey, next); this.#history.set(event, variants);
        break;
      }
      case "session.entry.result": {
        const entry = event.entry;
        if (entry && (hasSpecialBlock(entry) || options.codex && entryContainsDirective(entry))) {
          const original = projectEntry(entry);
          if (original) {
            const rendered = project(original);
            if (rendered !== original || hasSpecialBlock(entry)) next = { ...event, entry: { ...entry, data: { ...entry.data,
              message: { ...object(entry.data.message), ...rendered },
            } } };
          }
        }
        break;
      }
    }
    return next === event ? message : { ...envelope, event: next };
  }

  #delta(runtimeId: string, event: Extract<RuntimeEvent, { type: "message.delta" }>): RuntimeEvent {
    if ((event.contentType ?? "text") !== "text") return event;
    const key = `${runtimeId}\0${event.messageId}`;
    const previous = this.#streams.get(key) ?? { raw: "", visible: "", pending: false };
    if (previous.excessive) return { ...event, delta: "" };
    const raw = previous.raw + event.delta;
    if (raw.length > maxStreamLength) {
      this.#setStream(key, { raw: "", visible: "", pending: false, excessive: true });
      return { ...event, delta: "" }; // Authoritative finish/patch restores large bodies.
    }
    if (!previous.pending && !hasCodexDirective(event.delta) && !hasCitationSuffix(raw)) {
      this.#setStream(key, { raw, visible: previous.visible + event.delta, pending: false });
      return event;
    }
    const { text, pending } = renderStreamingMarkdown(raw);
    // A later delimiter can reclassify an unfinished Markdown span. Finish/patch will replace an
    // already emitted prefix; never append bytes based on a different prefix.
    if (!text.startsWith(previous.visible)) {
      this.#setStream(key, { raw, visible: previous.visible, pending: true });
      return { ...event, delta: "" };
    }
    this.#setStream(key, { raw, visible: text, pending });
    return { ...event, delta: text.slice(previous.visible.length) };
  }

  releaseRuntime(runtimeId: string): void {
    const prefix = `${runtimeId}\0`;
    for (const key of this.#streams.keys()) if (key.startsWith(prefix)) this.#streams.delete(key);
  }

  #setStream(key: string, value: Stream): void {
    this.#streams.delete(key); this.#streams.set(key, value);
    while (this.#streams.size > maxStreams) this.#streams.delete(this.#streams.keys().next().value!);
  }
}

function projectEntry(entry: RemoteSessionEntry): ChatMessage | undefined {
  return projectDisplayEntries([entry], entry.entryId, { boundaryParentId: entry.parentId }).entries[0]?.message ?? undefined;
}
function hasSpecialBlock(entry: RemoteSessionEntry): boolean {
  const content = object(entry.data.message)?.content ?? (entry.type === "custom_message" ? entry.data.content : undefined);
  return Array.isArray(content) && content.some(block => ["image", "input_image", "document", "attachment", "citation", "render"].includes(String(object(block)?.type)));
}
function entryContainsDirective(entry: RemoteSessionEntry): boolean {
  const content = object(entry.data.message)?.content;
  return typeof content === "string" ? hasCodexDirective(content) : Array.isArray(content) && content.some(raw => {
    const block = object(raw);
    return block?.type === "text" && typeof block.text === "string" && hasCodexDirective(block.text);
  });
}
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}
