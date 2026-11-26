import { describe, expect, it } from "vitest";
import { parseJson5, setJson5 } from "./json5-document.js";

// Native files are hand-edited: an edit that drops a comment or leaves an invalid comma breaks the user's Agent.
describe("JSON5 source-preserving edits", () => {
  const source = `// top\n{\n  // models\n  models: {\n    mode: 'merge', /* keep */\n    providers: {\n      "a": { baseUrl: 'https://a', n: .5, }, // a note\n      b: { x: +1e3, hex: 0xFF },\n    },\n  },\n  list: [1, 2,], s: "it's \\u4e2d\\n",\n}\n`;
  it("reads JSON5 syntax", () => {
    expect(parseJson5(source)).toEqual({ models: { mode: "merge", providers: { a: { baseUrl: "https://a", n: 0.5 }, b: { x: 1000, hex: 255 } } }, list: [1, 2], s: "it's 中\n" });
    for (const invalid of ["", "{", "{a:}", "{a 1}", "{a:1,,}", "{a:01}", "[1 2]", "{a:'x\n'}", "{} {}", "/* {}", "{a:1]"]) expect(() => parseJson5(invalid), invalid).toThrow();
  });
  it("adds, replaces and deletes without touching unrelated comments", () => {
    let text = setJson5(source, ["models", "providers", "c.d/é"], { apiKey: "k", models: [{ id: "m" }] });
    expect(text).toContain("// a note"); expect(text).toContain("/* keep */"); expect(text).toContain(`'https://a', n: .5, }`);
    text = setJson5(text, ["models", "providers", "b"], { x: 2 });
    for (const key of ["a", "c.d/é", "b"]) text = setJson5(text, ["models", "providers", key], undefined);
    expect(parseJson5(text)).toEqual({ ...(parseJson5(source) as object), models: { mode: "merge", providers: {} } });
    expect(text).toContain("// models");
    expect(parseJson5(setJson5(text, ["agents", "defaults", "model"], "x/y"))).toMatchObject({ agents: { defaults: { model: "x/y" } } });
  });
  it("keeps commas valid in every position, including one-line, empty and CRLF objects", () => {
    for (const base of ["{}", "{ }", "{\n}", '{"a":1}', '{"a":1,}', '{ "a": 1, "b": 2 }', "{\r\n  \"a\": 1 // c\r\n}", "{\n  // only\n}", "\ufeff{\"a\":1}"]) {
      const added = setJson5(base, ["z"], { v: [1] });
      expect(parseJson5(added), base).toEqual({ ...(parseJson5(base) as object), z: { v: [1] } });
      expect(parseJson5(setJson5(added, ["z"], undefined)), base).toEqual(parseJson5(base));
      if ((parseJson5(base) as { a?: number }).a) expect(parseJson5(setJson5(added, ["a"], undefined)), base).not.toHaveProperty("a");
      if (!base.startsWith("\ufeff")) expect(() => JSON.parse(setJson5('{"a":1}', ["b"], 2))).not.toThrow();
    }
  });
  it("refuses edits it cannot express safely", () => {
    expect(() => setJson5("{a:1}", ["a", "b"], 1)).toThrow();
    expect(() => setJson5("[1]", ["a"], 1)).toThrow();
    expect(() => setJson5("{a:1,a:2}", ["a"], undefined)).toThrow();
    expect(Object.hasOwn(parseJson5('{"__proto__":{"x":1}}') as object, "__proto__")).toBe(true);
  });
});
