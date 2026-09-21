/// <reference types="node" />
// WHIT-408 / WHIT-412 / WHIT-413 — every resolver in this project prefers a FILE over a folder of
// the same name (checked in TypeScript, Jest and metro-resolver). So if `src/X.ts` and `src/X/`
// both exist, `from '../X'` keeps hitting the file and everything under the folder is silently
// ignored: no error, no red test, the code just never runs. The typecheck catches a wrong import
// path; it cannot catch this.
//
// WHIT-408 was that exact collision — `src/theme.ts` beside a `src/theme/` holding the chart
// palette — and fixed it by moving the palette to `src/chartColors.ts`. Rather than name the two
// files involved, this guard walks src/ itself (walkSrc, in support/sourceScan.ts), so a new
// collision is caught the day it appears instead of the day someone remembers to add it here.
//
// WHIT-412 scanned only the top level of src/ and only .ts/.tsx. WHIT-413 walks src/ all the way
// down and covers .ts/.tsx/.js/.jsx: at every directory it flags any name that is BOTH a code file
// and a non-empty folder. "Non-empty" means the folder holds at least one non-dotfile entry — a
// nested subfolder counts. __tests__ is skipped, matching support/sourceScan.ts.
//
// An empty shadowed folder is tolerated, and so are dotfiles. Git prunes the emptied directory on
// checkout, so the husk that actually survives is one holding untracked junk — a Finder .DS_Store
// is the common case. Neither shadows anything, and reddening `npm test` for them would train
// people to ignore this guard. Only real modules are the hazard.
//
// Do NOT widen this to app/: `app/milestone.tsx` beside `app/milestone/edit.tsx` is ordinary
// expo-router sibling routing, and both ship as distinct routes. app/ is a sibling of src/, so this
// src-rooted walk never reaches it.
//
// walkSrc's own behaviour is proven against synthetic fixtures in the folded WHIT-413 block below.
// Same shape as the server's structural guards (tests/lambda_api/test_constants_sync.py).
import { afterEach, beforeEach, describe, it, expect } from '@jest/globals';
import { existsSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { walkSrc } from './support/sourceScan';

const SRC_DIR = join(__dirname, '..');

function isFile(relativePath: string): boolean {
  const absolute = join(SRC_DIR, relativePath);
  return existsSync(absolute) && statSync(absolute).isFile();
}

describe('WHIT-413 a shadowing name is a file, never a folder — everywhere under src/', () => {
  const { shadowPairs, visited } = walkSrc(SRC_DIR);

  // Each offending entry reads `dir/name`: src/dir/name.{ts,tsx,js,jsx} silently shadows
  // src/dir/name/. Jest prints the received array, so the remediation is in this test's name.
  it('flags no folder shadowed by a same-named code file — rename the file or move the folder out', () => {
    expect(shadowPairs).toEqual([]);
  });

  // Anti-degradation: a walk that silently scanned nothing (bad root, swallowed throw) would pass
  // the assertion above vacuously. Pin that it actually descended below the top level of src/.
  it('descends below the top level of src/', () => {
    expect(visited).toContain('motion');
  });

  it('keeps the app-wide tokens and the chart palette as separate top-level files', () => {
    expect(isFile('theme.ts')).toBe(true);
    expect(isFile('chartColors.ts')).toBe(true);
  });
});

// ===== WHIT-413 (folded from themeLayoutWalk.gaps.logic.test.ts) — [A1..A12] the shadowed-folder
// walk proven against SYNTHETIC fixture trees. The real-tree guard above can only assert
// shadowPairs === [], so on a clean src/ it cannot tell a correct walk from one that scanned
// nothing. These drive the real exported walkSrc(root) over controlled trees. Wrapped in an outer
// describe so its module-level fixture state (root, the beforeEach/afterEach temp-dir setup, and the
// file/emptyDir builders) stays scoped to these tests and never leaks into the survivor's suites.
// os.tmpdir + fs mkdir/mkdtemp/rm/writeFile + path.dirname imports merged into the survivor's above.
describe('themeLayoutWalk.gaps (WHIT-413) — synthetic fixture trees', () => {
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
});
