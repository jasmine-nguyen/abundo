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
// walkSrc's own behaviour is proven against synthetic fixtures in themeLayoutWalk.gaps.logic.test.ts.
// Same shape as the server's structural guards (tests/lambda_api/test_constants_sync.py).
import { describe, it, expect } from '@jest/globals';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
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
