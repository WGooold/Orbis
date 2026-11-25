import { isDeepStrictEqual } from "node:util";

type Obj = Record<string, unknown>;
type Member = { key: string; start: number; node: Node; comma: number | undefined };
type Node = { start: number; end: number; value: unknown; members?: Member[] };
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (target: Obj, key: string, value: unknown): void => { Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }); };

/** JSON / JSONC / JSON5 reader that keeps source ranges, so native files keep their comments and layout on edit. */
class Parser {
  #at = 0;
  constructor(readonly text: string) {}
  document(): Node {
    if (this.text.charCodeAt(0) === 0xfeff) this.#at = 1;
    const node = this.#value(0);
    this.#space();
    if (this.#at !== this.text.length) this.#fail();
    return node;
  }
  #fail(): never { throw new SyntaxError(`Invalid JSON5 at offset ${this.#at}`); }
  #space(): void {
    for (;;) {
      const char = this.text[this.#at];
      if (char !== undefined && /[\s\u2028\u2029\ufeff]/u.test(char)) { this.#at++; continue; }
      if (char !== "/") return;
      if (this.text[this.#at + 1] === "/") {
        while (this.#at < this.text.length && !/[\n\r\u2028\u2029]/u.test(this.text[this.#at]!)) this.#at++;
      } else if (this.text[this.#at + 1] === "*") {
        const end = this.text.indexOf("*/", this.#at + 2);
        if (end < 0) this.#fail();
        this.#at = end + 2;
      } else this.#fail();
    }
  }
  #value(depth: number): Node {
    if (depth > 200) this.#fail();
    this.#space();
    const start = this.#at, char = this.text[start];
    if (char === "{") return this.#object(start, depth);
    if (char === "[") {
      this.#at++;
      const value: unknown[] = [];
      for (;;) {
        this.#space();
        if (this.text[this.#at] === "]") { this.#at++; return { start, end: this.#at, value }; }
        value.push(this.#value(depth + 1).value);
        this.#space();
        if (this.text[this.#at] === ",") this.#at++;
        else if (this.text[this.#at] !== "]") this.#fail();
      }
    }
    if (char === '"' || char === "'") { const value = this.#string(char); return { start, end: this.#at, value }; }
    const word = /^[^\s,\]}:/]+/u.exec(this.text.slice(start, start + 400))?.[0] ?? "";
    this.#at += word.length;
    if (word === "true" || word === "false" || word === "null") return { start, end: this.#at, value: JSON.parse(word) as unknown };
    const signed = /^([+-]?)(Infinity|NaN|0[xX][\da-fA-F]+|(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/u.exec(word);
    if (!signed) this.#fail();
    const number = Number(signed[2]);
    return { start, end: this.#at, value: signed[1] === "-" ? -number : number };
  }
  #object(start: number, depth: number): Node {
    this.#at++;
    const value: Obj = {}, members: Member[] = [];
    for (;;) {
      this.#space();
      if (this.text[this.#at] === "}") { this.#at++; return { start, end: this.#at, value, members }; }
      const keyStart = this.#at, quote = this.text[keyStart];
      let key: string;
      if (quote === '"' || quote === "'") key = this.#string(quote);
      else {
        key = /^[\p{L}\p{Nl}$_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$\u200c\u200d]*/u.exec(this.text.slice(keyStart, keyStart + 400))?.[0] ?? this.#fail();
        this.#at += key.length;
      }
      this.#space();
      if (this.text[this.#at] !== ":") this.#fail();
      this.#at++;
      const node = this.#value(depth + 1);
      own(value, key, node.value);
      const member: Member = { key, start: keyStart, node, comma: undefined };
      members.push(member);
      this.#space();
      if (this.text[this.#at] === ",") member.comma = this.#at++;
      else if (this.text[this.#at] !== "}") this.#fail();
    }
  }
  #string(quote: string): string {
    let result = "";
    for (this.#at++; ;) {
      const char = this.text[this.#at++];
      if (char === undefined || char === "\n" || char === "\r") this.#fail();
      if (char === quote) return result;
      if (char !== "\\") { result += char; continue; }
      const escape = this.text[this.#at++];
      if (escape === undefined) this.#fail();
      if (escape === "\r" && this.text[this.#at] === "\n") { this.#at++; continue; }
      if (/[\n\r\u2028\u2029]/u.test(escape)) continue;
      if (escape === "u" || escape === "x") {
        const size = escape === "u" ? 4 : 2, hex = this.text.slice(this.#at, this.#at + size);
        if (hex.length !== size || !/^[\da-fA-F]+$/u.test(hex)) this.#fail();
        result += String.fromCharCode(parseInt(hex, 16)); this.#at += size; continue;
      }
      result += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" } as Record<string, string>)[escape] ?? escape;
    }
  }
}

export function parseJson5(text: string): unknown { return new Parser(text).document().value; }

function assign(target: Obj, path: string[], value: unknown): void {
  const key = path[0]!;
  if (path.length === 1) { if (value === undefined) delete target[key]; else own(target, key, structuredClone(value)); return; }
  if (!Object.hasOwn(target, key)) { if (value === undefined) return; own(target, key, {}); }
  assign(target[key] as Obj, path.slice(1), value);
}
const lineIndent = (text: string, at: number): string => /^[ \t]*/u.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1, at))![0];

/** Set (or, with `undefined`, delete) one semantic path, touching only its own source range. */
export function setJson5(text: string, path: string[], value: unknown): string {
  const root = new Parser(text).document();
  if (!isObject(root.value)) throw new SyntaxError("JSON5 root must be an object");
  let node = root;
  for (const [depth, key] of path.entries()) {
    if (!node.members) throw new SyntaxError("JSON5 parent must be an object");
    // Duplicate keys resolve to the last one, as the readers do.
    const index = node.members.map(item => item.key).lastIndexOf(key), member = node.members[index];
    const last = depth === path.length - 1;
    if (member && !last) { node = member.node; continue; }
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const render = (item: unknown, indent: string, unit: string): string => JSON.stringify(item, null, unit).replace(/\n/gu, eol + indent);
    let result: string;
    if (value === undefined) {
      if (!member) return text;
      // An earlier duplicate must not resurface.
      if (node.members.filter(item => item.key === key).length > 1) throw new SyntaxError("Duplicate JSON5 key");
      const previous = node.members[index - 1];
      let start = member.start, end = member.comma === undefined ? member.node.end : member.comma + 1;
      const lineStart = text.lastIndexOf("\n", start - 1) + 1, rest = /^[ \t]*\r?\n/u.exec(text.slice(end));
      if (rest && !text.slice(lineStart, start).trim()) { start = lineStart; end += rest[0].length; }
      result = text.slice(0, start) + text.slice(end);
      if (member.comma === undefined && previous?.comma !== undefined) result = result.slice(0, previous.comma) + result.slice(previous.comma + 1);
    } else {
      const base = lineIndent(text, node.start), first = node.members[0];
      const sibling = first && !text.slice(text.lastIndexOf("\n", first.start - 1) + 1, first.start).trim() ? lineIndent(text, first.start) : undefined;
      const indent = sibling ?? `${base}  `, unit = indent.startsWith(base) && indent.length > base.length ? indent.slice(base.length) : "  ";
      if (member) result = text.slice(0, member.node.start) + render(value, lineIndent(text, member.start), unit) + text.slice(member.node.end);
      else {
        let nested = value;
        for (const name of path.slice(depth + 1).reverse()) { const parent: Obj = {}; assign(parent, [name], nested); nested = parent; }
        const tail = node.members.at(-1), close = node.end - 1;
        let insert = close;
        while (insert > node.start + 1 && /\s/u.test(text[insert - 1]!)) insert--;
        const addition = `${eol}${indent}${JSON.stringify(key)}: ${render(nested, indent, unit)}${eol}${base}`;
        result = text.slice(0, insert) + addition + text.slice(close);
        if (tail && tail.comma === undefined) result = `${result.slice(0, tail.node.end)},${result.slice(tail.node.end)}`;
      }
    }
    const expected = structuredClone(root.value);
    assign(expected, path, value);
    if (!isDeepStrictEqual(parseJson5(result), expected)) throw new SyntaxError("JSON5 edit mismatch");
    return result;
  }
  return text;
}
