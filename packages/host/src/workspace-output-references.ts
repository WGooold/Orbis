import { isAbsolute, relative, resolve as resolvePath, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, type Token } from "marked";
import { nativeFilePreviewFormat, type ChatMessage, type RemoteContent } from "@orbis/protocol";
import { validMessageFilePathText } from "./message-file-references.js";

const markdown = new Marked({ gfm: true });
const outputSuffix = /\.(?:html?|svg|docx?|xlsx?|pptx?|zip)$/iu;

/** Only explicit Markdown destinations in a local session's workspace; never scan prose for paths. */
export function projectWorkspaceOutputs(message: ChatMessage, cwd: string,
  resolve: (path: string) => { referenceId: string; key: string } | undefined,
  known: ReadonlySet<string>,
): ChatMessage {
  if (message.role !== "assistant" || !isAbsolute(cwd)) return message;
  const outputs = new Map<string, RemoteContent>();
  const registered = new Set(known);
  for (const block of message.content) {
    const path = block.type === "artifact" ? block.artifact.path : undefined;
    if (path && isAbsolute(path)) {
      const target = resolvePath(path);
      registered.add(process.platform === "win32" ? target.toLowerCase() : target);
    }
  }
  for (const block of message.content) {
    if (block.type !== "text" || block.truncated || block.text.length > 256 * 1024 || !block.text.includes("[")) continue;
    const visit = (tokens: readonly Token[]): void => {
      let htmlDepth = 0;
      for (const token of tokens) {
        if (outputs.size >= 32) return;
        if (token.type === "html") {
          if (!token.block && !/^<(?:!|\?|(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b)/iu.test(token.raw) && !/\/>$/u.test(token.raw)) {
            htmlDepth = Math.max(0, htmlDepth + (token.raw.startsWith("</") ? -1 : 1));
          }
          continue;
        }
        if (htmlDepth || token.type === "code" || token.type === "codespan") continue;
        if (token.type === "link" || token.type === "image") {
          const target = workspaceOutputPath(token.href, cwd);
          if (!target) continue;
          const resolved = resolve(target.path);
          if (!resolved || registered.has(resolved.key)) continue;
          registered.add(resolved.key);
          outputs.set(resolved.key, { type: "render", renderKind: "file_reference", purpose: "output", text: target.name,
            file: { fileName: target.name, referenceId: resolved.referenceId } });
        } else if (token.type === "list") {
          for (const item of token.items) visit(item.tokens);
        } else if (token.type === "table") {
          for (const row of [token.header, ...token.rows]) for (const cell of row) visit(cell.tokens);
        } else if ("tokens" in token && Array.isArray(token.tokens)) visit(token.tokens);
      }
    };
    // The lexer may reject pathological Markdown; preserve the existing display if classification fails.
    let tokens: Token[];
    try { tokens = markdown.lexer(block.text); } catch { continue; }
    visit(tokens);
  }
  return outputs.size ? { ...message, content: [...message.content, ...outputs.values()] } : message;
}

function workspaceOutputPath(href: string, cwd: string): { path: string; name: string } | undefined {
  if (!href || href.length > 8192 || /[?#]/u.test(href)) return;
  const windows = process.platform === "win32";
  let path: string;
  try {
    if (/^file:\/\/\//iu.test(href)) path = fileURLToPath(href);
    else path = decodeURIComponent(href);
  } catch { return; }
  if (!validMessageFilePathText(path) || /^[\\/]{2}/u.test(path) || /[?#]/u.test(path)) return;
  const absolute = isAbsolute(path);
  if (windows ? (path.includes(":") && !/^[a-z]:[\\/][^:]*$/iu.test(path) || path.startsWith("/")) : /[:\\]/u.test(path)) return;
  const safePath = absolute ? relative(cwd, path) : path;
  if (!safePath || isAbsolute(safePath) || safePath.split(windows ? /[\\/]/u : sep).includes("..")) return;
  const name = safePath.split(windows ? /[\\/]/u : sep).at(-1)!;
  if (!name || name.length > 255 || !(nativeFilePreviewFormat(name) || outputSuffix.test(name))) return;
  // Register as a relative path even for an in-workspace absolute/FILE link, so the click-time realpath check also applies.
  return { path: windows ? win32.normalize(safePath) : safePath, name };
}
