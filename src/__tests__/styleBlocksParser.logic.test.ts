/// <reference types="node" />
// WHIT-423 — adversarial gaps for the styleBlocks() brace-balanced style-block reader.
//
// The guard accentAltWashCards.logic.test.ts leans entirely on styleBlocks() reading a block's
// FULL body past any nested/quoted brace. Its own self-tests cover a nested-object prop, a
// template-literal (whose `${idx}` already exercises a brace inside a backtick), an array-of-objects
// and a border-only block. These are the gaps those miss — each one, when the matching production
// line in support/sourceScan.ts is reverted, truncates the body BEFORE the colour props and so
// makes the wash guard silently stop seeing the surface.
import { describe, it, expect } from '@jest/globals';
import { styleBlocks } from './support/sourceScan';

// Read a block by name from a synthetic source and assert we got its WHOLE body — i.e. the reader
// did not stop early on a brace hidden in a string/escape/deep nest sitting before the colours.
const bodyOf = (src: string, name: string): string | undefined =>
  styleBlocks(src).find((b) => b.name === name)?.body;

describe('styleBlocks survives braces hidden in strings/escapes', () => {
  // [S1] An escaped quote inside a string value BEFORE the colours. If skipString stops honouring
  // the backslash escape, `'\''` is misread as a closed string + a new open string that then
  // swallows the following `'}'` literal, exposing its `}` as a bare brace that closes the block
  // early — the colours vanish. Reverting the `\\` escape line in skipString makes this fail.
  it("[S1] reads past an escaped quote ('\\'') sitting before the colour props", () => {
    const src = `const s = { card: { label: '\\'', dead: '}', backgroundColor: tint(C.accentAlt, 0.1), borderColor: tint(C.accentAlt, 0.22) } };`;
    const body = bodyOf(src, 'card');
    expect(body).toContain('backgroundColor: tint(C.accentAlt, 0.1)');
    expect(body).toContain('borderColor: tint(C.accentAlt, 0.22)');
  });

  // [S2] A literal `}` inside a SINGLE-quoted string before the colours. The implementer's self
  // tests only hide braces inside a backtick template and inside nested `{}` objects — never inside
  // a plain quoted string. Reverting the `char === "'"` arm of matchingBrace's string-skip lets the
  // `}` in `'}'` close the block early and drops the colours.
  it("[S2] reads past a '}' hidden in a single-quoted value", () => {
    const src = `const s = { row: { glyph: '}', backgroundColor: tint(C.accentAlt, 0.1), borderColor: tint(C.accentAlt, 0.22) } };`;
    const body = bodyOf(src, 'row');
    expect(body).toContain('backgroundColor: tint(C.accentAlt, 0.1)');
    expect(body).toContain('borderColor: tint(C.accentAlt, 0.22)');
  });

  // [S3] The same, DOUBLE-quoted. A wash surface may legitimately write colours/props in double
  // quotes (Prettier config differs per repo). Reverting the `char === '"'` arm of matchingBrace
  // makes the `}` in `"}"` close the block early.
  it('[S3] reads past a "}" hidden in a double-quoted value', () => {
    const src = `const s = { row: { glyph: "}", backgroundColor: tint(C.accentAlt, 0.1), borderColor: tint(C.accentAlt, 0.22) } };`;
    const body = bodyOf(src, 'row');
    expect(body).toContain('backgroundColor: tint(C.accentAlt, 0.1)');
    expect(body).toContain('borderColor: tint(C.accentAlt, 0.22)');
  });

  // [S4] Three levels of nesting before the colours. The self-test nests one object deep
  // (shadowOffset). A boolean "inside/outside" flag would pass that and fail here; only a real
  // depth counter reads to the block's own close. Reverting `--depth === 0` (e.g. to a boolean)
  // closes on the first inner `}` and drops the colours.
  it('[S4] reads past three-level {{{ }}} nesting before the colours', () => {
    const src = `const s = { deep: { a: { b: { c: 1 } }, backgroundColor: tint(C.accentAlt, 0.1), borderColor: tint(C.accentAlt, 0.22) } };`;
    const body = bodyOf(src, 'deep');
    expect(body).toContain('backgroundColor: tint(C.accentAlt, 0.1)');
    expect(body).toContain('borderColor: tint(C.accentAlt, 0.22)');
  });
});

describe('styleBlocks handles a malformed / unterminated block without corrupting the scan', () => {
  // [S5] An unterminated block (no closing brace) must be DROPPED, not returned with a garbage
  // body, and must not throw — a truncated source file mid-edit shouldn't crash the whole guard.
  // A well-formed sibling before it is still read in full. Reverting the `if (close === -1) continue`
  // guard makes the unterminated block appear (with a slice(open+1, -1) body).
  it('[S5] drops an unterminated block, keeps a valid sibling, never throws', () => {
    const src = `const s = { good: { backgroundColor: tint(C.accentAlt, 0.1), borderColor: tint(C.accentAlt, 0.22) }, bad: { x: 1 `;
    let blocks: { name: string; body: string }[] = [];
    expect(() => { blocks = styleBlocks(src); }).not.toThrow();
    const names = blocks.map((b) => b.name);
    expect(names).toContain('good');
    expect(names).not.toContain('bad');
    expect(bodyOf(src, 'good')).toContain('borderColor: tint(C.accentAlt, 0.22)');
  });
});
