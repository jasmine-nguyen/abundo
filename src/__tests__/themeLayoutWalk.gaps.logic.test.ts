/// <reference types="node" />
// WHIT-413 — [A1..A12] the shadowed-folder walk proven against SYNTHETIC fixture trees.
// The real-tree guard (themeLayout.logic.test.ts) can only ever assert `shadowPairs === []`,
// because a healthy src/ has no collisions — so on the clean tree it cannot tell a correct walk
// from one that scanned nothing. These fixtures drive the REAL exported walkSrc(root) over
// controlled trees, turning the manual fail-on-revert cases (nested shadow, .js shadow, empty
// folder, dotfile-only folder) into permanent automated guards, and adding the gaps: .jsx, deep
// 2+ nesting, subfolder-only "non-empty", reported path formatting, extension dedup, __tests__
// skip and the .d.ts base-name quirk.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { walkSrc } from './support/sourceScan';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'whit413-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Fixture builders — these only lay down files/dirs; they never re-implement the shadow logic,
// so every assertion below is against the real walkSrc.
const file = (relativePath: string) => {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, '');
};
const emptyDir = (relativePath: string) => mkdirSync(join(root, relativePath), { recursive: true });

describe('WHIT-413 walkSrc — shadow detection over synthetic trees', () => {
  // [A1] a .ts file beside a non-empty same-named folder is flagged.
  it('[A1] flags a .ts file shadowing a non-empty folder', () => {
    file('a.ts');
    file('a/inner.ts');
    expect(walkSrc(root).shadowPairs).toEqual(['a']);
  });

  // [A2] .tsx counts as a code file.
  it('[A2] flags a .tsx shadow', () => {
    file('b.tsx');
    file('b/inner.ts');
    expect(walkSrc(root).shadowPairs).toEqual(['b']);
  });

  // [A3] .js counts — WHIT-413 widened the extension set beyond .ts/.tsx.
  it('[A3] flags a .js shadow', () => {
    file('c.js');
    file('c/inner.ts');
    expect(walkSrc(root).shadowPairs).toEqual(['c']);
  });

  // [A4] .jsx counts — the fourth extension WHIT-413 added.
  it('[A4] flags a .jsx shadow', () => {
    file('d.jsx');
    file('d/inner.tsx');
    expect(walkSrc(root).shadowPairs).toEqual(['d']);
  });

  // [A5] recursion reaches 2+ levels down, and the reported pair is the full forward-slashed
  // relative path — proves the walk descends AND formats the path.
  it('[A5] flags a shadow nested two levels deep with a slashed path', () => {
    file('x/y/z.ts');
    file('x/y/z/w.ts');
    const { shadowPairs, visited } = walkSrc(root);
    expect(shadowPairs).toEqual(['x/y/z']);
    // anti-degradation at depth: it genuinely walked down to x/y before flagging.
    expect(visited).toContain('x/y');
  });

  // [A6] an EMPTY shadowed folder is tolerated — git prunes emptied dirs, husks are noise.
  it('[A6] does not flag an empty shadowed folder', () => {
    file('e.ts');
    emptyDir('e');
    expect(walkSrc(root).shadowPairs).toEqual([]);
  });

  // [A7] a folder holding ONLY dotfiles (Finder .DS_Store) is tolerated.
  it('[A7] does not flag a folder holding only dotfiles', () => {
    file('f.ts');
    file('f/.DS_Store');
    expect(walkSrc(root).shadowPairs).toEqual([]);
  });

  // [A8] "non-empty" includes a folder whose only entry is a SUBFOLDER — a subfolder counts.
  it('[A8] flags a folder whose only visible entry is a subfolder', () => {
    file('g.ts');
    emptyDir('g/sub');
    expect(walkSrc(root).shadowPairs).toEqual(['g']);
  });

  // [A9] a folder shadowed by several same-named code files (X.ts AND X.js — a real case) is still
  // reported once as the folder, not once per file.
  it('[A9] reports a shadowed folder once even with several same-named code files beside it', () => {
    file('m.ts');
    file('m.js');
    file('m/inner.ts');
    expect(walkSrc(root).shadowPairs).toEqual(['m']);
  });

  // [A10] __tests__ is skipped: a __tests__.ts file beside __tests__/ is NOT flagged, and the walk
  // never descends into __tests__. (Characterises the exclusion the guard relies on.)
  it('[A10] skips __tests__ folders entirely', () => {
    file('__tests__.ts');
    file('__tests__/inner.ts');
    const { shadowPairs, visited } = walkSrc(root);
    expect(shadowPairs).toEqual([]);
    expect(visited).not.toContain('__tests__');
  });

  // [A11] a healthy mixed tree yields NO false positives — real code files, an unrelated folder,
  // an empty husk and a dotfile husk all coexist cleanly.
  it('[A11] reports nothing for a clean mixed tree', () => {
    file('api.ts');
    file('theme.ts');
    file('components/Button.tsx');
    emptyDir('theme'); // empty husk beside theme.ts — tolerated
    file('leftovers/.DS_Store'); // dotfile-only folder, no code file beside it
    expect(walkSrc(root).shadowPairs).toEqual([]);
  });

  // [A12] documents the .d.ts base-name quirk: `types.d.ts` strips only the trailing `.ts`, leaving
  // base name `types.d`, so it does NOT flag a sibling `types/` folder. Pins current behaviour so a
  // future change to the extension regex is a conscious one.
  it('[A12] does NOT flag a folder shadowed only by a .d.ts declaration (base-name quirk)', () => {
    file('types.d.ts');
    file('types/index.ts');
    expect(walkSrc(root).shadowPairs).toEqual([]);
  });
});
