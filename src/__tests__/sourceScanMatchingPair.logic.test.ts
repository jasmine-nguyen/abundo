// WHIT-681 QA — matchingBrace (support/sourceScan.ts) now takes any open/close pair. The cache-in-act
// guard (cacheRefreshInAct.logic.test.ts) relies on the '(' ')' form; the colour guards rely on the '{' '}' default staying put.
import { describe, it, expect } from '@jest/globals';
import { matchingBrace, styleBlocks } from './support/sourceScan';

describe('matchingBrace with a custom pair', () => {
  // [A1] nested calls, a template literal holding ')', an escaped quote → still the act's own ')'.
  it('closes the act call past nested parens and parens inside strings', () => {
    const source = "act(async () => { f(g(1), `)${x}`); h('it\\'s )'); client.x(); }); after();";
    const close = matchingBrace(source, 3, '(', ')');
    expect(source.slice(close)).toBe('); after();');
  });

  // [A2] the open/close arguments are honoured both ways: braces are ignored when matching parens.
  it('ignores braces when matching parens', () => {
    const source = '(a, { b: 1 }, }) tail';
    expect(matchingBrace(source, 0, '(', ')')).toBe(source.indexOf(') tail'));
  });
});

describe('matchingBrace default is unchanged for the colour guards', () => {
  // [A3] a style block with parens and a quoted '}' still reads whole through styleBlocks.
  it('styleBlocks reads a block holding calls and a quoted brace', () => {
    const blocks = styleBlocks("const s = { card: { transform: [{ scale: f(1) }], label: '}', color: c(2) } };");
    const card = blocks.find((block) => block.name === 'card');
    expect(card?.body).toBe(" transform: [{ scale: f(1) }], label: '}', color: c(2) ");
  });

  it('matches braces by default, skipping a quoted brace', () => {
    expect(matchingBrace('a: { b: { c: 1 }, d: "}" } tail', 3)).toBe(25);
  });
});
