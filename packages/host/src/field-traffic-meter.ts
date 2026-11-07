import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as Protocol from "@orbis/protocol";
import type { TransportFieldsRequest, TransportFieldsPage, TransportFieldRow } from "@orbis/protocol";

type Group = { count: number; bytes: number; sampledAt: number };
type Field = { count: number; nonNull: number; sum: number; own: number; max: number; repeats: number; repeatBytes: number; digest: string; sizes: number[]; group: string; path: string };
type Label = { backend: string; messageType: string; reason: TransportFieldRow["reason"] };
type Node = { path: string; start: number; end: number; own: number; nonNull: boolean };
const fieldNames = new Set<string>();
const visited = new Set<object>();
// Only registered property names can appear in reports; dynamic native/user keys are never logged.
function keys(schema: any): void {
  if (!schema || typeof schema !== "object" || visited.has(schema)) return;
  visited.add(schema);
  if (schema.type === "object") for (const [key, child] of Object.entries(schema.shape)) { fieldNames.add(key); keys(child); }
  else if (schema.type === "union") schema.options.forEach(keys);
  else if (schema.type === "array") keys(schema._def.element);
  else if (schema._def?.innerType) keys(schema._def.innerType);
  else if (schema.type === "record") keys(schema._def.valueType);
}
for (const [name, value] of Object.entries(Protocol)) if (name.endsWith("Schema")) keys(value);

/** Scan the already serialized bytes once. Inclusive subtree sizes and disjoint
 * structural overhead are different measures, never added to one another. */
function measure(buffer: Buffer): Node[] {
  let offset = 0; const nodes: Node[] = [];
  function whitespace(): void { while ([9, 10, 13, 32].includes(buffer[offset] ?? -1)) offset++; }
  function string(): void {
    if (buffer[offset++] !== 34) throw Error("string");
    while (offset < buffer.length) { const byte = buffer[offset++]!; if (byte === 92) offset++; else if (byte === 34) return; }
    throw Error("string_end");
  }
  function value(path: string, depth: number): number {
    if (depth > 32 || path.length > 2048 || nodes.length >= 16_384) throw Error("sample_budget");
    whitespace(); const start = offset; const kind = buffer[offset]; let children = 0;
    if (kind === 123 || kind === 91) {
      const close = kind === 123 ? 125 : 93; offset++; whitespace();
      while (buffer[offset] !== close) {
        let key = "[]";
        if (kind === 123) {
          const keyStart = offset; string();
          if (offset - keyStart < 256) { const raw = JSON.parse(buffer.subarray(keyStart, offset).toString()) as string; key = fieldNames.has(raw) ? raw : "*"; }
          else key = "*";
          whitespace(); if (buffer[offset++] !== 58) throw Error("colon");
        }
        children += value(kind === 91 ? path + "[]" : path + "." + key, depth + 1);
        whitespace(); if (buffer[offset] === close) break;
        if (buffer[offset++] !== 44) throw Error("comma"); whitespace();
      }
      offset++;
    } else if (kind === 34) string();
    else { while (offset < buffer.length && ![44, 93, 125, 9, 10, 13, 32].includes(buffer[offset]!)) offset++; if (offset === start) throw Error("scalar"); }
    const size = offset - start;
    nodes.push({ path, start, end: offset, own: size - children, nonNull: !(size === 4 && buffer[start] === 110 && buffer[start + 1] === 117 && buffer[start + 2] === 108 && buffer[start + 3] === 108) });
    return size;
  }
  value("$", 0); whitespace(); if (offset !== buffer.length) throw Error("trailing"); return nodes;
}

/** FT-G09: bounded, content-free statistics. No log writes or model commits. */
export class FieldTrafficMeter {
  readonly #salt = randomBytes(16);
  readonly #groups = new Map<string, Group>();
  readonly #labels = new Map<string, Label>();
  readonly #fields = new Map<string, Field>();
  readonly #pages = new Map<string, { id: string; at: number; rows: TransportFieldRow[]; sampledMessages: number; sampledBytes: number; skippedSamples: number }>();
  readonly #started: number;
  #window: number; #windowBytes = 0; #sampledMessages = 0; #sampledBytes = 0; #skipped = 0;
  constructor(readonly now: () => number = Date.now) { this.#started = this.#window = now(); }
  record(payload: Uint8Array, label: Label): void {
    const time = this.now(), id = JSON.stringify(label);
    let group = this.#groups.get(id);
    if (!group) {
      if (this.#groups.size >= 512) { this.#skipped++; return; }
      group = { count: 0, bytes: 0, sampledAt: -Infinity }; this.#groups.set(id, group); this.#labels.set(id, label);
    }
    group.count++; group.bytes += payload.byteLength;
    if (label.messageType === "transport.fields.page") return;
    if (group.count !== 1 && group.count % 32 !== 0 && time - group.sampledAt < 1000) return;
    if (time - this.#window >= 60_000) { this.#window = time; this.#windowBytes = 0; }
    if (payload.byteLength > 2 * 1024 * 1024 || this.#windowBytes + payload.byteLength > 8 * 1024 * 1024) { this.#skipped++; return; }
    group.sampledAt = time; this.#windowBytes += payload.byteLength;
    const buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    let nodes: Node[]; try { nodes = measure(buffer); } catch { this.#skipped++; return; }
    this.#sampledMessages++; this.#sampledBytes += buffer.length;
    for (const node of nodes) {
      const key = id + node.path; let field = this.#fields.get(key);
      if (!field) {
        if (this.#fields.size >= 8192) { this.#skipped++; continue; }
        field = { count: 0, nonNull: 0, sum: 0, own: 0, max: 0, repeats: 0, repeatBytes: 0, digest: "", sizes: [], group: id, path: node.path }; this.#fields.set(key, field);
      }
      const size = node.end - node.start, digest = createHash("sha256").update(this.#salt).update(buffer.subarray(node.start, node.end)).digest("base64url");
      if (digest === field.digest) { field.repeats++; field.repeatBytes += size; }
      field.digest = digest; field.count++; field.nonNull += Number(node.nonNull); field.sum += size; field.own += node.own; field.max = Math.max(field.max, size);
      if (field.sizes.length < 128) field.sizes.push(size);
      else { const index = Math.floor(Math.random() * field.count); if (index < 128) field.sizes[index] = size; }
    }
  }
  snapshot(): TransportFieldRow[] {
    return [...this.#fields.values()].map(field => {
      const group = this.#groups.get(field.group)!, samples = [...field.sizes].sort((a, b) => a - b);
      return { ...this.#labels.get(field.group)!, path: field.path, sampleCount: field.count, nonNullCount: field.nonNull,
        meanBytes: field.sum / field.count, p95Bytes: samples[Math.ceil(samples.length * .95) - 1]!, maxBytes: field.max,
        totalSampleBytes: field.sum, ownSampleBytes: field.own, repeatedCount: field.repeats, repeatedBytes: field.repeatBytes,
        messageCount: group.count, messageBytes: group.bytes };
    }).sort((a, b) => b.totalSampleBytes - a.totalSampleBytes);
  }
  release(device: string): void { this.#pages.delete(device); }
  page(device: string, request: TransportFieldsRequest): TransportFieldsPage {
    const now = this.now(); let page = this.#pages.get(device), offset = 0;
    const failure = (): TransportFieldsPage => ({ type: "transport.fields.page", protocolVersion: Protocol.PROTOCOL_VERSION, requestId: request.requestId,
      snapshotId: null, offset: 0, totalRows: 0, rows: [], nextCursor: null, startedAt: this.#started, observedAt: now,
      sampledMessages: this.#sampledMessages, sampledBytes: this.#sampledBytes, skippedSamples: this.#skipped, error: "invalid_cursor" });
    if (request.cursor !== null) {
      try {
        const cursor: unknown = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
        if (!page || now - page.at > 60_000 || !Array.isArray(cursor) || cursor.length !== 2 || cursor[0] !== page.id ||
          !Number.isSafeInteger(cursor[1]) || cursor[1] < 0 || cursor[1] >= page.rows.length) return failure();
        offset = cursor[1] as number;
      } catch { return failure(); }
    } else {
      page = { id: randomUUID(), at: now, sampledMessages: this.#sampledMessages, sampledBytes: this.#sampledBytes, skippedSamples: this.#skipped, rows: this.snapshot().filter(row => (!request.backend || row.backend === request.backend) && (!request.messageType || row.messageType === request.messageType)) };
      this.#pages.set(device, page);
      while (this.#pages.size > 8 || [...this.#pages.values()].reduce((count, item) => count + item.rows.length, 0) > 16_384) this.#pages.delete(this.#pages.keys().next().value!);
    }
    if (!page) return failure();
    const rows = page.rows.slice(offset, offset + (request.limit ?? 100));
    while (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows)) > 56 * 1024) rows.pop();
    const end = offset + rows.length;
    const header = failure(); delete header.error;
    return { ...header, snapshotId: page.id, offset, totalRows: page.rows.length, rows, observedAt: page.at,
      sampledMessages: page.sampledMessages, sampledBytes: page.sampledBytes, skippedSamples: page.skippedSamples,
      nextCursor: end < page.rows.length ? Buffer.from(JSON.stringify([page.id, end])).toString("base64url") : null };
  }
}
