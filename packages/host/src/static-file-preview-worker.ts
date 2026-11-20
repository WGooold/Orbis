import { createHash } from "node:crypto";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import postcss from "postcss";

const htmlNS = "http://www.w3.org/1999/xhtml";
const svgNS = "http://www.w3.org/2000/svg";
const tags = new Set("html head body title main section article header footer nav aside h1 h2 h3 h4 h5 h6 p div span pre code blockquote ol ul li dl dt dd table caption colgroup col thead tbody tfoot tr th td strong em b i u s small mark sub sup hr br figure figcaption details summary time a style".split(" "));
const voidTags = new Set(["br", "hr", "col"]);
const svgTags = new Set("svg g defs title desc path rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop".split(" "));
const svgNumbers = new Set("x y x1 y1 x2 y2 cx cy fx fy r rx ry width height dx dy viewBox points stroke-width stroke-dasharray stroke-dashoffset stroke-miterlimit opacity stroke-opacity fill-opacity stop-opacity font-size offset".split(" "));
const svgPaint = new Set(["fill", "stroke", "stop-color", "color"]);
const svgWords = new Set("preserveAspectRatio gradientUnits spreadMethod text-anchor dominant-baseline fill-rule clip-rule stroke-linecap stroke-linejoin vector-effect font-family font-weight font-style".split(" "));
// No resource-bearing properties, CSS variables, custom functions, animation, filters or extended paint.
const cssProperties = new Set(("color background background-color border border-color border-style border-width border-top border-right border-bottom border-left border-radius " +
  "border-collapse border-spacing box-sizing display vertical-align text-align text-decoration text-transform text-indent text-overflow " +
  "font font-family font-size font-style font-weight letter-spacing word-spacing line-height white-space overflow-wrap word-break " +
  "padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left " +
  "width min-width max-width height min-height max-height overflow overflow-x overflow-y opacity " +
  "flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content gap row-gap column-gap " +
  "list-style-type list-style-position table-layout caption-side fill stroke stroke-width stroke-linejoin stroke-linecap fill-opacity stroke-opacity").split(" "));
const escape = (text: string): string => text.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const reject = (): never => { throw new Error("unsupported_preview"); };
const restrictedNumber = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?/g;
const boundedNumbers = (value: string): boolean => {
  for (const match of value.matchAll(restrictedNumber)) if (!Number.isFinite(Number(match[0])) || Math.abs(Number(match[0])) > 100_000) return false;
  return true;
};

/** ADR-0093: project a static subset, never feed original markup to a mobile WebView. */
export function prepareStaticFilePreview(source: Uint8Array, format: "html" | "svg", maxBytes: number): { bytes: Uint8Array; sha256: string } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (text.trim() === "" || text.includes("\u0000")) reject();
  const root = parse(format === "svg" ? text.replace(/^\s*<\?xml\s[^?]{1,200}\?>/i, "") : text, { scriptingEnabled: false });
  let elements = 0, declarations = 0, rules = 0, pathCost = 0, cssCost = 0, textCost = 0;
  function style(value: string, sheet: boolean): string {
    if (value.length > 16_384 || (cssCost += value.length) > 32_768 || /[<\\]/.test(value)) reject();
    const tree = postcss.parse(sheet ? value : `x{${value}}`);
    const renderRule = (node: (typeof tree.nodes)[number]): string => {
      if (node.type === "comment") return "";
      if (node.type !== "rule") return reject();
      const selector = node.selector;
      // Static selectors only; no history, complex matching, or recursive functional selectors.
      if (++rules > 128 || selector.length > 128 || !/^[a-z\d_ .#,:>+*~-]+$/i.test(selector) || /:(?!root\b|first-child\b|last-child\b|hover\b|focus\b)/i.test(selector)) reject();
      const body = node.nodes.map(decl => {
        if (decl.type === "comment") return "";
        if (decl.type !== "decl") return reject();
        const property = decl.prop.toLowerCase();
        const val = decl.value;
        if (++declarations > 1024 || !cssProperties.has(property) || val.length > 180 ||
          !/^[\w\s#%.,'"/+()-]+$/.test(val) || [...val.matchAll(/([\w-]+)\s*\(/g)].some(match => !/^(?:rgb|rgba|hsl|hsla)$/i.test(match[1]!)) || !boundedNumbers(val)) reject();
        return `${property}:${val}${decl.important ? "!important" : ""};`;
      }).join("");
      return sheet ? `${selector}{${body}}` : body;
    };
    if (!sheet && (tree.nodes.length !== 1 || tree.nodes[0]?.type !== "rule" || tree.nodes[0].selector !== "x")) reject();
    return tree.nodes.map(renderRule).join("");
  }
  function render(node: DefaultTreeAdapterMap["childNode"], depth: number): string {
    if (depth > 32) reject();
    if ("value" in node) {
      if ((textCost += node.value.length) > 256 * 1024) reject();
      return escape(node.value);
    }
    if (!("tagName" in node)) return "";
    const { tagName: tag, namespaceURI, attrs, childNodes } = node;
    if (++elements > 2048 || attrs.length > 32) reject();
    const svg = namespaceURI === svgNS;
    if (namespaceURI === htmlNS && tag === "meta") {
      if (attrs.some(a => a.name === "http-equiv")) reject();
      return ""; // Encoding and viewport are supplied by the reader.
    }
    if (svg ? !svgTags.has(tag) : namespaceURI !== htmlNS || !tags.has(tag)) reject();
    const attributes: string[] = [];
    for (const attr of attrs) {
      const { name, value } = attr;
      if (name === "xmlns" && tag === "svg" && value === svgNS) continue;
      if (attr.namespace || name.startsWith("on")) reject();
      if (name === "style") { attributes.push(`style="${escape(style(value, false))}"`); continue; }
      if (name === "href" && tag === "a") continue; // retain the label, not a clickable link
      if (name === "id" || name === "class" || name === "title" || name === "lang" || name === "dir" || name === "role" || /^aria-[a-z-]{1,50}$/.test(name)) {
        if (value.length > 512) reject();
      } else if (!svg) {
        if ((tag === "td" || tag === "th" || tag === "col") && /^(colspan|rowspan|span)$/.test(name) && /^[1-9]\d?$/.test(value)) { /* bounded table layout */ }
        else if (tag === "details" && name === "open") { /* boolean */ }
        else continue; // other attributes cannot affect resource loading in the emitted document
      } else if (name === "d" || name === "transform" || name === "gradientTransform" || svgNumbers.has(name)) {
        if (value.length > 12_288 || (pathCost += value.length) > 64_000 || !/^[\d\s.,%()+a-z-]*$/i.test(value) || !boundedNumbers(value)) reject();
        if ((name === "width" || name === "height") && parseFloat(value) > 4096) reject();
      } else if (svgPaint.has(name)) {
        if (value.length > 100 || !/^(?:url\(#[a-z_][\w.-]*\)|[\w#%,. ()+-]+)$/i.test(value)) reject();
        if (/url\s*\(/i.test(value) && !/^url\(#[a-z_][\w.-]*\)$/i.test(value)) reject();
      } else if (svgWords.has(name)) {
        if (value.length > 96 || !/^[\w ,.'"+-]+$/.test(value)) reject();
      } else continue;
      attributes.push(`${name}="${escape(value)}"`);
    }
    if (tag === "style") {
      const stylesheet = childNodes.map(child => "value" in child ? child.value : reject()).join("");
      return `<style>${style(stylesheet, true)}</style>`;
    }
    const start = `<${tag}${attributes.length ? " " + attributes.join(" ") : ""}>`;
    const children = childNodes.map(child => render(child, depth + 1)).join("");
    if (tag === "head") return `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width, initial-scale=1">${children}</head>`;
    return voidTags.has(tag) && !svg ? start : `${start}${children}</${tag}>`;
  }
  if (format === "svg") {
    const html = root.childNodes.find((node): node is DefaultTreeAdapterMap["element"] => "tagName" in node && node.tagName === "html");
    const body = html?.childNodes.find((node): node is DefaultTreeAdapterMap["element"] => "tagName" in node && node.tagName === "body");
    const content = body?.childNodes.filter(node => "tagName" in node || ("value" in node && node.value.trim() !== ""));
    if (content?.length !== 1 || !("tagName" in content[0]!) || content[0].tagName !== "svg") reject();
  }
  const bytes = new TextEncoder().encode("<!doctype html>" + root.childNodes.map(node => render(node, 0)).join(""));
  if (bytes.length > maxBytes) throw new Error("preview_too_large");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

if (!isMainThread && workerData?.orbisStaticFilePreview === true) {
  try {
    const result = prepareStaticFilePreview(workerData.bytes, workerData.format, workerData.maxBytes);
    parentPort?.postMessage(result, [result.bytes.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort?.postMessage({ reason: error instanceof Error && error.message === "preview_too_large" ? "too_large" : "unsupported" });
  }
}
