import { Marked, type Token } from "marked";
import type { ChatMessage, MessageFileReference, RemoteContent } from "./index.js";

export const LEGACY_DISPLAY_PROJECTION_VERSION = 3;
export const MESSAGE_FILE_PREFIX = "orbis-message-file:";
const name = ":codex-file-citation";
const fileMarkers = [`${name}{`, `${name}[codex-file-citation]{`];
const followup = ":codex-followup[";
const visualization = "::codex-inline-vis{";
const visualizationReference = "\ue200visualize\ue202";
const markers = [...fileMarkers, followup, visualization, visualizationReference];
export const hasCodexDirective = (source: string): boolean => source.includes(name) || markers.slice(2).some(marker => source.includes(marker));
const maxDirectiveLength = 8192;
const markdown = new Marked({ gfm: true });

type FileCitation = { path: string; purpose: "source" | "output"; line?: number; endLine?: number };
type Candidate = { start: number; end: number; citation?: FileCitation; replacement?: string };
type TextContent = Extract<RemoteContent, { type: "text" }>;
type ResolveFile = (path: string) => { referenceId: string; key: string } | undefined;
const control = (value: string): boolean => [...value].some(ch => {
  const cp = ch.codePointAt(0)!;
  return cp < 32 || cp === 127 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
});

/** Codex only: overwrite device presentation, never the native message. */
export function normalizeCodexMessage(message: ChatMessage, resolve: ResolveFile, streaming = false): ChatMessage {
  if (message.role !== "assistant") return message;
  const outputs = new Map<string, Extract<RemoteContent, { type: "render" }>>();
  const content = message.content.map((block): RemoteContent => {
    if (block.type !== "text") return block;
    return projectText(block, streaming || block.truncated === true, (citation, standalone) => {
      const fileName = Array.from(citation.path.split(/[\\/]/u).at(-1)!).reduce((name, ch) =>
        name.length + ch.length <= 255 ? name + ch : name, "");
      const resolved = resolve(citation.path);
      const file: MessageFileReference = { fileName,
        ...(resolved ? { referenceId: resolved.referenceId } : {}),
        ...(citation.line === undefined ? {} : { line: citation.line }),
        ...(citation.endLine === undefined ? {} : { endLine: citation.endLine }) };
      const label = citation.line === undefined ? fileName : `${fileName}:${citation.line}${citation.endLine === undefined ? "" : `–${citation.endLine}`}`;
      if (citation.purpose === "output" && !streaming && (outputs.size < 32 || outputs.has(resolved?.key ?? citation.path))) {
        const key = resolved?.key ?? citation.path;
        if (!outputs.has(key)) outputs.set(key, { type: "render", renderKind: "file_reference", purpose: "output", text: label, file });
        if (standalone) return "";
      }
      return resolved ? `[${escapeMarkdown(label)}](<${resolved.referenceId}>)` : escapeMarkdown(label);
    });
  });
  if (outputs.size === 0 && content.every((block, i) => block === message.content[i])) return message;
  const visible = content.map(block => outputs.size > 0 && block.type === "text" ? { ...block, text: block.text.replace(/[ \t\n\r]+$/gu, "") } : block)
    .filter(block => block.type !== "text" || block.text.trim() || block.truncated);
  return { ...message, content: [...visible, ...outputs.values()] };
}

/** Released App/adapter parsers receive only their existing text vocabulary and display revision. */
export function downgradeMessageForLegacy(message: ChatMessage): ChatMessage {
  let changed = false;
  const content = message.content.map((block): RemoteContent => {
    if (block.type === "render") { changed = true; return { type: "text", text: block.text }; }
    if (block.type !== "text") return block;
    const plain = stripMessageFileReferenceTargets(block.text);
    if (plain === block.text) return block;
    changed = true;
    return { ...block, text: plain };
  });
  return changed ? { ...message, content } : message;
}

export function stripMessageFileReferenceTargets(text: string): string {
  return text.replace(/\[((?:\\.|[^\\[\]\r\n])+)\]\(<orbis-message-file:[a-f0-9]{64}>\)/gu,
    (_match, label: string) => label.replace(/\\([\\[\]`*_{}])/gu, "$1"));
}

/** Legacy append events carry a readable preview. The authoritative message carries file actions. */
export function renderStreamingMarkdown(text: string, resolve?: ResolveFile): { text: string; pending: boolean } {
  const projected = normalizeCodexMessage({ messageId: "preview", role: "assistant", timestamp: 0, content: [{ type: "text", text }] }, resolve ?? (() => undefined), true);
  const value = downgradeMessageForLegacy(projected).content[0];
  return { text: value?.type === "text" ? value.text : "", pending: pendingCandidate(text) !== undefined };
}

function projectText(block: TextContent, streaming: boolean,
  label: (citation: FileCitation, standalone: boolean) => string): TextContent {
  const source = block.text;
  if (!hasCodexDirective(source) && (!streaming || !hasCitationSuffix(source))) return block;
  const candidates = scanCandidates(source, streaming);
  if (candidates.length === 0) return block;
  const visible = proseCandidates(source, candidates);
  if (!visible.size) return block;
  let text = "", offset = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (!visible.has(index)) continue;
    text += source.slice(offset, candidate.start);
    if (candidate.citation) {
      const lineStart = source.lastIndexOf("\n", candidate.start - 1) + 1;
      const lineEnd = source.indexOf("\n", candidate.end);
      const standalone = !source.slice(lineStart, candidate.start).trim() &&
        !source.slice(candidate.end, lineEnd === -1 ? undefined : lineEnd).trim();
      text += label(candidate.citation, standalone);
    } else if (candidate.replacement !== undefined) text += candidate.replacement;
    offset = candidate.end;
  }
  return { ...block, text: text + source.slice(offset) };
}

/** Mask each candidate with an inert token before lexing. Brackets/backticks inside quoted paths
 * are directive data. The Markdown lexer still owns all surrounding code, HTML and link contexts. */
function proseCandidates(source: string, candidates: Candidate[]): Set<number> {
  let prefix = "qZOrbisFileQz";
  while (source.includes(prefix)) prefix += "z";
  let masked = "", offset = 0;
  for (const [index, { start, end }] of candidates.entries()) {
    masked += source.slice(offset, start) + prefix + index + "Zq";
    offset = end;
  }
  const lexer = markdown.lexer(masked + source.slice(offset));
  const pattern = new RegExp(`${prefix}(\\d+)Zq`, "gu");
  const visible = new Set<number>();
  const visit = (tokens: readonly Token[]): void => {
    const html: string[] = [];
    for (const token of tokens) {
      if (token.type === "html") {
        const tag = /^<(\/?)([a-z][a-z\d-]*)(?:\s+[^>]*|\/?)>/iu.exec(token.raw);
        if (tag && !token.block && !/\/>$/u.test(token.raw)) {
          const name = tag[2]!.toLowerCase();
          if (tag[1] === "/") { const index = html.lastIndexOf(name); if (index >= 0) html.splice(index); }
          else if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/u.test(name)) html.push(name);
        }
        continue;
      }
      if (html.length || ["code", "codespan", "link", "image", "def", "escape"].includes(token.type)) continue;
      if (token.type === "table") {
        for (const row of [token.header, ...token.rows]) for (const cell of row) visit(cell.tokens);
      } else if (token.type === "list") {
        for (const item of token.items) visit(item.tokens);
      } else if ("tokens" in token && Array.isArray(token.tokens)) visit(token.tokens);
      else if (token.type === "text") for (const match of token.raw.matchAll(pattern)) visible.add(Number(match[1]));
    }
  };
  visit(lexer);
  return visible;
}

function directiveSuffixIndex(value: string): number {
  const last = Math.max(value.lastIndexOf(":"), value.lastIndexOf("\ue200"));
  if (last < 0) return -1;
  let begin = last;
  while (begin > 0 && value[begin - 1] === ":") begin--;
  return markers.some(marker => (value.length - last < marker.length && marker.startsWith(value.slice(last))) ||
    (value.length - begin < marker.length && marker.startsWith(value.slice(begin)))) ? begin : -1;
}
export function hasCitationSuffix(value: string): boolean { return directiveSuffixIndex(value) >= 0; }

function pendingCandidate(source: string): Candidate | undefined {
  const tail = scanCandidates(source, true).at(-1);
  return tail?.citation === undefined && tail?.replacement === undefined ? tail : undefined;
}

function scanCandidates(source: string, streaming: boolean): Candidate[] {
  const result: Candidate[] = [];
  const starts = /:codex-file-citation|:codex-followup\[|::codex-inline-vis\{|\ue200visualize\ue202/gu;
  for (const hit of source.matchAll(starts)) {
    const start = hit.index;
    if (start < (result.at(-1)?.end ?? 0)) continue;
    let scanned: Candidate | undefined;
    if (hit[0] === name) {
      const marker = fileMarkers.find(value => source.startsWith(value, start));
      let begin = start;
      while (begin > 0 && source[begin - 1] === ":") begin--;
      if (marker && start - begin <= 2 && !isEscaped(source, begin)) scanned = readDirective(source, begin, start + marker.length);
    } else if (!isEscaped(source, start)) {
      if (hit[0] === followup && source[start - 1] !== ":") scanned = readFollowup(source, start, streaming);
      else if (hit[0] === visualization || hit[0] === visualizationReference) scanned = readVisualization(source, start, hit[0]);
    }
    if (scanned && (scanned.citation || scanned.replacement !== undefined || streaming)) result.push(scanned);
  }
  const tail = streaming ? directiveSuffixIndex(source) : -1;
  if (tail >= (result.at(-1)?.end ?? 0) && !isEscaped(source, tail)) result.push({ start: tail, end: source.length });
  return result;
}

function readFollowup(source: string, start: number, streaming: boolean): Candidate | undefined {
  const from = start + followup.length;
  const limit = Math.min(source.length, from + maxDirectiveLength);
  let depth = 1;
  for (let end = from; end < limit; end++) {
    const ch = source[end];
    if (ch === "\n" || ch === "\r") return undefined;
    if (ch === "\\") { end++; continue; }
    if (ch === "[") depth++;
    if (ch !== "]" || --depth !== 0) continue;
    const label = source.slice(from, end).trim();
    if (!label || control(label)) return undefined;
    if (streaming && end + 1 === source.length) return { start, end: source.length };
    if (source[end + 1] !== "{") return { start, end: end + 1, replacement: escapeMarkdown(label) };
    const attrs = readDirectiveBody(source, end + 2);
    return attrs?.body === undefined ? (attrs && { start, end: attrs.end }) :
      parsePairs(attrs.body) ? { start, end: attrs.end, replacement: escapeMarkdown(label) } : undefined;
  }
  return limit === source.length ? { start, end: limit } : undefined;
}

function readVisualization(source: string, start: number, marker: string): Candidate | undefined {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  if (source.slice(lineStart, start).trim()) return undefined;
  const newline = source.indexOf("\n", start);
  const end = newline < 0 ? source.length : newline;
  if (end - start > maxDirectiveLength) return undefined;
  const line = source.slice(start, end).trimEnd();
  if (marker === visualization) {
    if (!line.endsWith("}")) return newline < 0 ? { start, end } : undefined;
    if (!/^file="[^"\r\n]+"$/u.test(line.slice(marker.length, -1).trim())) return undefined;
  } else {
    if (!line.endsWith("\ue201")) return newline < 0 ? { start, end } : undefined;
    try {
      const payload: unknown = JSON.parse(line.slice(marker.length, -1));
      const path = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>).path : undefined;
      if (typeof path !== "string" || !/^(?:\/|[a-z]:[\\/])/iu.test(path) || control(path)) return undefined;
    } catch { return undefined; }
  }
  return { start, end, replacement: "可视化内容暂不可显示" };
}

function readDirective(source: string, start: number, from: number): Candidate | undefined {
  const result = readDirectiveBody(source, from);
  if (!result) return undefined;
  if (result.body === undefined) return { start, end: result.end };
  const citation = parseAttributes(result.body);
  return citation ? { start, end: result.end, citation } : undefined;
}

function readDirectiveBody(source: string, from: number): { end: number; body?: string } | undefined {
  let quote: string | undefined;
  for (let i = from; i < source.length && i - from < maxDirectiveLength; i++) {
    const ch = source[i]!;
    if (ch === "\n" || ch === "\r" || source.startsWith(name, i)) return undefined;
    if (ch === "\\" && quote && (source[i + 1] === quote || source[i + 1] === "\\")) { i++; continue; }
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "}") {
      return { end: i + 1, body: source.slice(from, i) };
    }
  }
  return source.length - from < maxDirectiveLength ? { end: source.length } : undefined;
}

function parsePairs(body: string): Map<string, string> | undefined {
  const entries = new Map<string, string>();
  const attribute = /\s*([a-z][a-z\d_-]*)\s*=\s*(?:"((?:\\["\\]|[^"\\]|\\(?!["\\]))*)"|'((?:\\['\\]|[^'\\]|\\(?!['\\]))*)'|([^\s"'=]+))(?=\s|$)/iyu;
  const trimmed = body.trimEnd();
  while (attribute.lastIndex < trimmed.length) {
    const match = attribute.exec(trimmed);
    if (!match || entries.has(match[1]!)) return undefined;
    const value = match[2] !== undefined ? match[2].replace(/\\(["\\])/gu, "$1")
      : match[3] !== undefined ? match[3].replace(/\\(['\\])/gu, "$1") : match[4]!;
    entries.set(match[1]!, value);
  }
  return entries;
}

function parseAttributes(body: string): FileCitation | undefined {
  const entries = parsePairs(body);
  if (!entries) return undefined;
  let path = entries.get("path");
  const purpose = entries.get("purpose") ?? "source";
  if (!path || path.length > 4096 || control(path) || (purpose !== "source" && purpose !== "output")) return undefined;
  const suffix = /:(\d+)(?::\d+)?$/u.exec(path);
  if (suffix && !(suffix.index === 1 && /^[a-z]:/iu.test(path))) path = path.slice(0, suffix.index);
  if (/^[\\/]{2}/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/](?![\\/])/iu.test(path)) return undefined;
  const fileName = path.split(/[\\/]/u).at(-1);
  if (!fileName || fileName === "." || fileName === "..") return undefined;
  const start = entries.get("line") ?? entries.get("line_number") ?? entries.get("start_line") ?? entries.get("line_start") ?? entries.get("line_range_start") ?? suffix?.[1];
  const end = entries.get("end_line") ?? entries.get("line_end") ?? entries.get("line_range_end");
  const line = start === undefined ? undefined : Number(start);
  const endLine = end === undefined ? undefined : Number(end);
  if (start !== undefined && (!/^\d+$/u.test(start) || !Number.isSafeInteger(line) || line! < 1) ||
      end !== undefined && (!/^\d+$/u.test(end) || !Number.isSafeInteger(endLine) || line === undefined || endLine! < line)) return undefined;
  return { path, purpose, ...(line === undefined ? {} : { line }), ...(endLine === undefined ? {} : { endLine }) };
}

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 !== 0;
}

function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]<>!~|&$]/gu, "\\$&"); }
