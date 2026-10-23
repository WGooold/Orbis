import type { OutboundQueueDiagnostic, OutboundQueueSource, PathKind, MuxChannel } from "@pi-remote/protocol";
import type { QueueAdmissionRejection } from "./device-link.js";
import type { DiagnosticAppendInput } from "./diagnostic-journal.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function label(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 256) : undefined;
}

/** Read an explicit metadata allowlist from the existing object; never parse/copy its serialized body. */
export function outboundQueueSource(message: object, payloadBytes: number): OutboundQueueSource {
  const root = message as Record<string, unknown>;
  const event = root.type === "runtime.event" ? object(root.event) : undefined;
  const runtime = root.type === "runtime.online" ? object(root.runtime) : undefined;
  const runtimeId = label(root.runtimeId) ?? label(runtime?.runtimeId);
  const sessionId = label(root.sessionId) ?? label(event?.sessionId) ?? label(runtime?.sessionId);
  const domains = root.type === "agent.state.snapshot" && Array.isArray(root.domains)
    ? root.domains.slice(0, 64).map(domain => label(object(domain)?.domain)).filter(domain => domain !== undefined).sort().join(",").slice(0, 256)
    : undefined;
  return {
    type: label(root.type) ?? "unattributed", payloadBytes,
    ...(event === undefined ? {} : { eventType: label(event.type) ?? "unknown" }),
    ...(runtimeId === undefined ? {} : { runtimeId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(domains === undefined ? {} : { domains }),
  };
}

/** Separate source records keep every field within DiagnosticJournal's 16-key/256-char limits. */
export function outboundQueueDiagnosticRecords(
  deviceId: string, path: PathKind, sample: OutboundQueueDiagnostic, at = Date.now(),
): DiagnosticAppendInput[] {
  const base = {
    scope: "host" as const, agentKind: null, category: "transport.queue", severity: "warning" as const,
    operationId: `outbound-queue:${deviceId}:${path}:${at}`, at,
  };
  return [{
    ...base, sessionId: null, message: "outbound_queue_pressure", detail: {
      deviceId, path, queuedBytes: String(sample.queuedBytes), nonBulkQueuedBytes: String(sample.nonBulkQueuedBytes),
      bulkQueuedBytes: String(sample.bulkQueuedBytes), transportBacklogBytes: String(sample.transportBacklogBytes),
      oldestQueuedMs: String(sample.oldestQueuedMs), windowMs: String(sample.windowMs),
      nonBulkEnqueuedBytes: String(sample.nonBulkEnqueuedBytes), nonBulkWrittenBytes: String(sample.nonBulkWrittenBytes),
      writeErrors: String(sample.writeErrors), otherSourceBytes: String(sample.otherSourceBytes),
      sourcesTruncated: String(sample.sourcesTruncated),
    },
  }, ...sample.sources.map((source, index) => ({
    ...base, sessionId: source.sessionId ?? null, message: "outbound_queue_source", detail: {
      deviceId, path, rank: String(index + 1), type: source.type,
      ...(source.eventType === undefined ? {} : { eventType: source.eventType }),
      ...(source.runtimeId === undefined ? {} : { runtimeId: source.runtimeId }),
      ...(source.domains === undefined ? {} : { domains: source.domains }),
      channel: source.channel, queuedBytes: String(source.queuedBytes), queuedPieces: String(source.queuedPieces),
      oldestQueuedMs: String(source.oldestQueuedMs), maxPayloadBytes: String(source.maxPayloadBytes),
    },
  }))];
}

/** Record a bounded admission rejection without serializing the queued payload. */
export function outboundQueueAdmissionRecord(
  deviceId: string, path: PathKind, rejection: QueueAdmissionRejection, at = Date.now(),
): DiagnosticAppendInput {
  const source = rejection.source;
  return {
    scope: "host", agentKind: null, sessionId: source?.sessionId ?? null, category: "transport.queue",
    severity: "warning", operationId: `outbound-admission:${deviceId}:${path}:${at}`,
    message: "outbound_queue_admission_rejected", at,
    detail: {
      deviceId, path, channel: rejection.channel as MuxChannel,
      requestedBytes: String(rejection.requestedBytes), queuedBytes: String(rejection.queuedBytes),
      queueLimitBytes: String(rejection.queueLimitBytes),
      ...(source?.type === undefined ? {} : { sourceType: source.type }),
      ...(source?.eventType === undefined ? {} : { eventType: source.eventType }),
      ...(source?.runtimeId === undefined ? {} : { runtimeId: source.runtimeId }),
    },
  };
}
