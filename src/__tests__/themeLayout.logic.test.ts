/// <reference types="node" />
// WHIT-408 / WHIT-412 — every resolver in this project prefers a FILE over a folder of the same
// name (checked in TypeScript, Jest and metro-resolver). So if `src/X.ts` and `src/X/` both exist,
// `from '../X'` keeps hitting the file and everything under the folder is silently ignored:
// no error, no red test, the code just never runs. The typecheck catches a wrong import path;
// it cannot catch this.
//
// WHIT-408 was that exact collision — `src/theme.ts` beside a `src/theme/` holding the chart
// palette — and fixed it by moving the palette to `src/chartColors.ts`. Rather than name the two
// files involved, this guard derives the list from src/ itself, so a new collision is caught the
// day it appears instead of the day someone remembers to add it here.
//
// An empty shadowed folder is tolerated, and so are dotfiles. Git prunes the emptied directory on
// checkout, so the husk that actually survives is one holding untracked junk — a Finder .DS_Store
// is the common case. Neither shadows anything, and reddening `npm test` for them would train
// people to ignore this guard. Only real modules are the hazard.
//
// Do NOT widen this to app/: `app/milestone.tsx` beside `app/milestone/edit.tsx` is ordinary
// expo-router sibling routing, and both ship as distinct routes.
//
// Same shape as the server's structural guards (tests/lambda_api/test_constants_sync.py).
import { describe, it, expect } from '@jest/globals';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_DIR = join(__dirname, '..');

function isFile(relativePath: string): boolean {
  const absolute = join(SRC_DIR, relativePath);
  return existsSync(absolute) && statSync(absolute).isFile();
}

// Every top-level module in src/, by bare name — `api.ts` → `api`. Each one shadows a folder of
// that name, so each one is a place the trap can reappear. Deduped: `X.ts` and `X.tsx` are one name.
function shadowingNames(): string[] {
  const modules = readdirSync(SRC_DIR).filter((entry) => isFile(entry) && /\.tsx?$/.test(entry));
  return [...new Set(modules.map((entry) => entry.replace(/\.tsx?$/, '')))].sort();
}

function modulesIn(name: string): string[] {
  const directory = join(SRC_DIR, name);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((entry) => !entry.startsWith('.'));
}

describe('WHIT-412 a shadowing name is a file, never a folder', () => {
  // The remediation lives in the test NAME on purpose — Jest prints the name on failure but not
  // the comments around it, so advice written here as a comment never reaches the developer.
  it.each(shadowingNames())(
    'has no module under src/%s/ — the same-named .ts file silently shadows one, so keep modules at the top of src/',
    (name) => {
      expect(modulesIn(name)).toEqual([]);
    },
  );

  it('derives its list from src/ rather than a hard-coded pair', () => {
    const names = shadowingNames();
    expect(names).toContain('theme');
    expect(names).toContain('chartColors');
  });

  it('keeps the app-wide tokens and the chart palette as separate top-level files', () => {
    expect(isFile('theme.ts')).toBe(true);
    expect(isFile('chartColors.ts')).toBe(true);
  });
});
