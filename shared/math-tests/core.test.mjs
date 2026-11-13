// MATH-01: boundaries and actual KaTeX compilation for the reported formulas.
import {test} from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath, URL} from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const scope = {};
vm.runInNewContext(fs.readFileSync(path.join(here, '../math/core.js'), 'utf8'), scope);
const math = scope.OrbisMath;
const engineScope = {module: {exports: {}}, exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(here, '../math/katex.min.js'), 'utf8'), engineScope);
const katex = engineScope.module.exports;
const compile = (tex, displayMode = true) => katex.renderToString(tex, {displayMode, throwOnError: true, strict: 'ignore', trust: false, maxExpand: 500, maxSize: 20, macros: {}});
const cases = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')).map(({name, source, count}) => [name, source, count]);
for (const [name, source, count] of cases) test(name, () => {
  const prepared = math.protect(source);
  assert.equal(prepared.tokens.filter(t => !t.pending).length, count);
  let restored = prepared.text;
  for (const token of prepared.tokens) restored = restored.replace(token.marker, () => token.raw);
  assert.equal(restored, source);
  for (const token of prepared.tokens.filter(t => !t.pending)) assert.match(compile(token.tex, token.display), /class="katex/);
});
test('reported shared score and telescoping sum compile', () => {
  for (const tex of [String.raw`\boxed{\hat d_{ij}=g_\theta(X_j)-g_\theta(X_i)}`, String.raw`\sum_{k=1}^{t}[g_\theta(X_k)-g_\theta(X_{k-1})]=g_\theta(X_t)-g_\theta(X_0)`, String.raw`S_{s,i}=a_sL_{s,i}+b_s+\varepsilon_{s,i}`, String.raw`\sqrt{x}+\binom{n}{k}+\int_0^1x\,dx+\mathbb{R}+\vec{x}`]) assert.match(compile(tex), /katex/);
});
test('bad and recursive macros fail within configured budget', () => {
  assert.throws(() => compile(String.raw`\unknownCommand{x}`));
  assert.throws(() => compile(String.raw`\def\a{\a}\a`));
  assert.doesNotMatch(compile(String.raw`\href{https://example.test}{x}`), /href=|<a /);
});
test('visible newlines do not change multiline TeX attributes', () => {
  const source = String.raw`A & B \[x\\
y\]`;
  const p = math.protect(source);
  const result = math.inlineHTML([{text:p.text,bold:true}],p);
  assert.equal(result.hasMath,true); assert.match(result.html,/A &amp; B/);
  const attribute = result.html.match(/data-raw="([^"]*)"/)[1];
  assert.equal(attribute, source.slice(6));
  assert.doesNotMatch(attribute, /<br>/);
});
test('oversized formulas and marker collisions preserve text', () => {
  const p = math.protect('\uE000orbis-math-0\uE001 ' + String.raw`\[` + 'x'.repeat(17000) + String.raw`\]`);
  assert.equal(p.tokens[0].pending,true); assert.notEqual(p.prefix,'\uE000orbis-math-');
});
test('unfinished links cannot hide subsequent paragraphs', () => {
  const p = math.protect('[broken](url\n\n' + String.raw`\(x\)`);
  assert.equal(p.tokens.length, 1);
});
test('empty explicit formulas preserve their source', () => {
  const p = math.protect(String.raw`\(\)`);
  assert.equal(p.tokens[0].pending, true);
  assert.equal(p.tokens[0].raw, String.raw`\(\)`);
});
