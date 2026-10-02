// WHIT-699 — the WHIT-672 budget/loan guard finds test files through the shared walker
// (support/sourceScan.ts `testFiles`) and is pinned in the WHIT-684 GUARDS list so it can't drift.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripComments } from './support/sourceScan';

const GUARD = 'whit672BudgetLoanSuitesRealQueries.logic.test.ts';
const read = (file: string) => stripComments(readFileSync(join(__dirname, file), 'utf8'));

// Built from parts so this file never contains what it hunts for.
const OWN_WALK = new RegExp('\\b(' + ['readdir' + 'Sync', 'stat' + 'Sync'].join('|') + ')\\b');
const LOCAL_WALKER = new RegExp('function\\s+(' + ['test' + 'Files', 'source' + 'Files'].join('|') + ')\\s*\\(');
const SHARED_IMPORT = new RegExp("import\\s*\\{[^}]*\\btestFiles\\b[^}]*\\}\\s*from\\s*'\\./support/sourceScan'");

describe('WHIT-672 budget/loan guard uses the shared test-file walker', () => {
  it('imports the shared testFiles walker and has no walker of its own', () => {
    const code = read(GUARD);
    expect(code).toMatch(SHARED_IMPORT);
    expect(code).not.toMatch(LOCAL_WALKER);
    expect(code).not.toMatch(OWN_WALK);
  });

  it('is listed in the WHIT-684 GUARDS list so it cannot drift again', () => {
    const code = read('whit684GuardsShareWalker.logic.test.ts');
    const guards = code.match(/const GUARDS = \[([^\]]*)\]/);
    expect(guards).not.toBeNull();
    expect(guards![1]).toContain(`'${GUARD}'`);
  });
});
