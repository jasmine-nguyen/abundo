/// <reference types="node" />
// WHIT-408 — `src/theme.ts` (the app-wide tokens) and a folder `src/theme/` (the Insights chart
// palette) used to sit side by side under nearly the same name. Every resolver in this project
// prefers the FILE over a folder of the same name — checked in TypeScript, Jest and metro-resolver
// — so if a module ever lands back under `src/theme/`, NOTHING turns red: every `from '../theme'`
// import keeps hitting theme.ts and the new file is dead weight no one notices. The typecheck
// catches a wrong import path; it cannot catch this. That is what this guard is for.
//
// `chartColors` is guarded too: the move created a SECOND shadowing name, and `src/chartColors.ts`
// would swallow a future `src/chartColors/` folder in exactly the same silent way. Guarding only
// the old name would leave the trap open one rename later.
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

// Top-level modules whose name must stay a FILE. A folder of the same name is silently shadowed
// by it, so nothing may live inside one.
const SHADOWING_NAMES = ['theme', 'chartColors'];

function isFile(relativePath: string): boolean {
  const absolute = join(SRC_DIR, relativePath);
  return existsSync(absolute) && statSync(absolute).isFile();
}

function modulesIn(name: string): string[] {
  const directory = join(SRC_DIR, name);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((entry) => !entry.startsWith('.'));
}

describe('WHIT-408 a shadowing name is a file, never a folder', () => {
  // The remediation lives in the test NAME on purpose — Jest prints the name on failure but not
  // the comments around it, so advice written here as a comment never reaches the developer.
  it.each(SHADOWING_NAMES)(
    'has no module under src/%s/ — the same-named .ts file silently shadows one, so keep modules at the top of src/',
    (name) => {
      expect(modulesIn(name)).toEqual([]);
    },
  );

  it('keeps the app-wide tokens and the chart palette as separate top-level files', () => {
    expect(isFile('theme.ts')).toBe(true);
    expect(isFile('chartColors.ts')).toBe(true);
  });
});
