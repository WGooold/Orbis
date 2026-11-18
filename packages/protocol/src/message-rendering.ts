import { Marked, type Token } from "marked";
import type { ChatMessage, MessageFileReference, RemoteContent } from "./index.js";

export const LEGACY_DISPLAY_PROJECTION_VERSION = 3;
export const MESSAGE_FILE_PREFIX = "orbis-message-file:";
const name = ":codex-file-citation";
const markers = [`${name}{`, `${name}[codex-file-citation]{`];
const maxDirectiveLength = 8192;
const markdown = new Marked({ gfm: true });

type FileCitation = { path: string; purpose: "source" | "output"; line?: number; endLine?: number };
type Candidate = { start: number; end: number; citation?: FileCitation };
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
    return projectText(block, streaming || block.truncated === true, citation => {
      const fileName = Array.from(citation.path.split(/[\\/]/u).at(-1)!).reduce((name, ch) =>
        name.length + ch.length <= 255 ? name + ch : name, "");
      const resolved = resolve(citation.path);
      const file: MessageFileReference = { fileName,
        ...(resolved ? { referenceId: resolved.referenceId } : {}),
        ...(citation.line === undefined ? {} : { line: citation.line }),
        ...(citation.endLine === undefined ? {} : { endLine: citation.endLine }) };
      const label = citation.line === undefined ? fileName : `${fileName}:${citation.line}${citation.endLine === undefined ? "" : `–${citation.endLine}`}`;
      if (citation.purpose === "output" && !streaming) {
        const key = resolved?.key ?? citation.path;
        if (!outputs.has(key)) outputs.set(key, { type: "render", renderKind: "file_reference", purpose: "output", text: label, file });
        return "";
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
  return text.replace(/\[((?:\\.|[^\]])+)\]\(<orbis-message-file:[a-f0-9]{64}>\)/gu,
    (_match, label: string) => label.replace(/\\([\\[\]`*_{}])/gu, "$1"));
}

/** Legacy append events carry a readable preview. The authoritative message carries file actions. */
export function renderStreamingMarkdown(text: string, resolve?: ResolveFile): { text: string; pending: boolean } {
  const projected = normalizeCodexMessage({ messageId: "preview", role: "assistant", timestamp: 0, content: [{ type: "text", text }] }, resolve ?? (() => undefined), true);
  const value = downgradeMessageForLegacy(projected).content[0];
  return { text: value?.type === "text" ? value.text : "", pending: pendingCandidate(text) !== undefined };
}

function projectText(block: TextContent, streaming: boolean,
  label: (citation: FileCitation) => string): TextContent {
  const source = block.text;
  if (!source.includes(name) && (!streaming || !hasCitationSuffix(source))) return block;
  const candidates = scanCandidates(source, streaming);
  if (candidates.length === 0) return block;
  const visible = proseCandidates(source, candidates);
  if (!visible.size) return block;
  let text = "", offset = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (!visible.has(index)) continue;
    text += source.slice(offset, candidate.start);
    if (candidate.citation) text += label(candidate.citation);
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

export function hasCitationSuffix(value: string): boolean {
  const last = value.lastIndexOf(":");
  return last >= 0 && markers.some(marker => value.length - last < marker.length && marker.startsWith(value.slice(last)));
}

function pendingCandidate(source: string): Candidate | undefined {
  const tail = scanCandidates(source, true).at(-1);
  return tail?.citation === undefined ? tail : undefined;
}

function scanCandidates(source: string, streaming: boolean): Candidate[] {
  const result: Candidate[] = [];
  for (let start = source.indexOf(name); start >= 0; ) {
    const marker = markers.find(value => source.startsWith(value, start));
    let begin = start;
    while (begin > 0 && source[begin - 1] === ":") begin--;
    const scanned = !marker || start - begin > 2 || isEscaped(source, begin) ? undefined : readDirective(source, begin, start + marker.length);
    if (scanned && (scanned.citation || streaming)) result.push(scanned);
    start = source.indexOf(name, scanned?.end ?? start + name.length);
  }
  if (streaming && hasCitationSuffix(source)) {
    let start = source.lastIndexOf(":");
    while (start > 0 && source[start - 1] === ":") start--;
    if (start >= (result.at(-1)?.end ?? 0) && !isEscaped(source, start)) result.push({ start, end: source.length });
  }
  return result;
}

function readDirective(source: string, start: number, from: number): Candidate | undefined {
  let quote: string | undefined;
  for (let i = from; i < source.length && i - from < maxDirectiveLength; i++) {
    const ch = source[i]!;
    if (ch === "\n" || ch === "\r" || source.startsWith(name, i)) return undefined;
    if (ch === "\\" && quote && (source[i + 1] === quote || source[i + 1] === "\\")) { i++; continue; }
    if (quote) { if (ch === quote) quote = undefined; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "}") {
      const citation = parseAttributes(source.slice(from, i));
      return citation ? { start, end: i + 1, citation } : undefined;
    }
  }
  return source.length - from < maxDirectiveLength ? { start, end: source.length } : undefined;
}

function parseAttributes(body: string): FileCitation | undefined {
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
  let path = entries.get("path");
  const purpose = entries.get("purpose") ?? "source";
  if (!path || path.length > 4096 || control(path) || /^[a-z][a-z\d+.-]*:(?![\\/])/iu.test(path) || /^[\\/]{2}|^[a-z][a-z\d+.-]*:\/\//iu.test(path) ||
      (purpose !== "source" && purpose !== "output")) return undefined;
  const suffix = /:(\d+)(?::\d+)?$/u.exec(path);
  if (suffix && !(suffix.index === 1 && /^[a-z]:/iu.test(path))) path = path.slice(0, suffix.index);
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
