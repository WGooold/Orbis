import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { parseTOML, type AST } from "toml-eslint-parser";
import { ProviderError } from "./provider-error.js";

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const prefix = (a: string[], b: string[]): boolean => a.length <= b.length && a.every((key, i) => key === b[i]);
const keyParts = (key: AST.TOMLKey): string[] => key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
const quoteKey = (key: string): string => /^[\w-]+$/.test(key) ? key : JSON.stringify(key);
function withoutEmptyTables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmptyTables);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutEmptyTables(item)]).filter(([, item]) => !isObject(item) || Object.keys(item).length > 0));
}
function literal(value: unknown): string {
  if (isObject(value)) return `{ ${Object.entries(value).map(([key, item]) => `${quoteKey(key)} = ${literal(item)}`).join(", ")} }`;
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  return stringify({ value } as Parameters<typeof stringify>[0]).replace(/^value\s*=\s*/, "").trimEnd();
}
function at(value: unknown, path: string[]): unknown {
  for (const key of path) value = isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}
function assign(value: Obj, path: string[], next: unknown): void {
  const key = path[0]!;
  if (path.length === 1) {
    if (next === undefined) delete value[key];
    else Object.defineProperty(value, key, { value: structuredClone(next), enumerable: true, configurable: true, writable: true });
    return;
  }
  if (!Object.hasOwn(value, key) || !isObject(value[key])) Object.defineProperty(value, key, { value: {}, enumerable: true, configurable: true, writable: true });
  assign(value[key] as Obj, path.slice(1), next);
}

/** Change a semantic path using TOML source ranges, retaining unrelated comments and ordering. */
export function setToml(text: string, path: string[], value: unknown): string {
  try {
    const before = parse(text) as Obj;
    if (isDeepStrictEqual(at(before, path), value)) return text;
    const ast = parseTOML(text);
    const entries: { node: AST.TOMLKeyValue; path: string[] }[] = [];
    const tables: AST.TOMLTable[] = [];
    for (const node of ast.body[0].body) {
      if (node.type === "TOMLKeyValue") entries.push({ node, path: keyParts(node.key) });
      else {
        tables.push(node);
        // Array-of-table data is replaced as a complete subtree; never address its numeric indices.
        for (const child of node.body) entries.push({ node: child, path: [...node.resolvedKey.map(String), ...keyParts(child.key)] });
      }
    }
    const container = entries.find(entry => prefix(entry.path, path));
    let result: string;
    if (container) {
      if (container.path.length === path.length && value === undefined) {
        result = text.slice(0, container.node.range[0]) + text.slice(container.node.range[1]);
      } else {
        let replacement = value;
        if (container.path.length < path.length) {
          replacement = structuredClone(at(before, container.path));
          if (!isObject(replacement)) throw new Error("Scalar parent");
          assign(replacement, path.slice(container.path.length), value);
        }
        result = text.slice(0, container.node.value.range[0]) + literal(replacement) + text.slice(container.node.value.range[1]);
      }
    } else {
      const removedTables = tables.filter(table => prefix(path, table.resolvedKey.map(String)));
      const ranges = [
        ...removedTables.map(table => table.range),
        ...entries.filter(entry => prefix(path, entry.path) && !removedTables.some(table => entry.node.parent === table)).map(entry => entry.node.range),
      ].sort((a, b) => b[0] - a[0]);
      if (ranges.length) {
        result = ranges.reduce((source, [start, end]) => source.slice(0, start) + source.slice(end), text);
        if (value !== undefined) result = setToml(result, path, value);
      } else if (value === undefined) return text;
      else {
        const table = tables.filter(item => item.kind === "standard" && prefix(item.resolvedKey.map(String), path) && item.resolvedKey.length < path.length)
          .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
        const insert = table ? table.range[1] : tables[0]?.range[0] ?? text.length;
        const keys = path.slice(table?.resolvedKey.length ?? 0).map(quoteKey).join(".");
        result = `${text.slice(0, insert)}\n${keys} = ${literal(value)}\n${text.slice(insert)}`;
      }
    }
    const expected = structuredClone(before);
    assign(expected, path, value);
    if (!isDeepStrictEqual(withoutEmptyTables(parse(result)), withoutEmptyTables(expected))) throw new Error("TOML edit mismatch");
    return result;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("无法保留原格式修改 TOML；请检查配置结构");
  }
}

export function mergeToml(target: string, source: string): string {
  const visit = (value: Obj, path: string[]): void => {
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      if (isObject(item) && isObject(at(parse(target), next))) visit(item, next);
      else target = setToml(target, next, item);
    }
  };
  visit(parse(source) as Obj, []);
  return target;
}

/** CC Switch's common snippet removal only removes matching values (and matching array members). */
export function removeToml(target: string, source: string): string {
  const visit = (value: Obj, path: string[]): void => {
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      const current = at(parse(target), next);
      if (isObject(item) && isObject(current)) {
        visit(item, next);
        const remaining = at(parse(target), next);
        if (isObject(remaining) && !Object.keys(remaining).length) target = setToml(target, next, undefined);
      } else if (Array.isArray(item) && Array.isArray(current)) {
        const remaining = current.filter(entry => !item.some(other => isDeepStrictEqual(entry, other)));
        target = setToml(target, next, remaining.length ? remaining : undefined);
      } else if (isDeepStrictEqual(current, item)) target = setToml(target, next, undefined);
    }
  };
  visit(parse(source) as Obj, []);
  return target;
}
