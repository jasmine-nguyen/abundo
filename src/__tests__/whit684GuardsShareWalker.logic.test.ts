// WHIT-684 — the test-tree guards find test files through the one shared walker
// (support/sourceScan.ts `testFiles`), so a change to how test files are found is made in one place.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripComments } from './support/sourceScan';

const TESTS_DIR = __dirname;
const GUARDS = [
  'cacheRefreshInAct.logic.test.ts',
  'cacheInActSingleGuard.logic.test.ts',
  'testQueryClientShared.logic.test.ts',
  'whit672BudgetLoanSuitesRealQueries.logic.test.ts',
];
// Built from parts so this file never contains what it hunts for.
const OWN_WALK = new RegExp('\\b(' + ['readdir' + 'Sync', 'stat' + 'Sync'].join('|') + ')\\b');
const LOCAL_WALKER = new RegExp('function\\s+(' + ['test' + 'Files', 'source' + 'Files'].join('|') + ')\\s*\\(');
const SHARED_IMPORT = new RegExp("import\\s*\\{[^}]*\\btestFiles\\b[^}]*\\}\\s*from\\s*'\\./support/sourceScan'");

describe('test-tree guards share one test-file walker', () => {
  it.each(GUARDS)('%s finds test files with the shared testFiles walker, not its own', (guard) => {
    const code = stripComments(readFileSync(join(TESTS_DIR, guard), 'utf8'));
    expect(code).toMatch(SHARED_IMPORT);
    expect(code).not.toMatch(LOCAL_WALKER);
    expect(code).not.toMatch(OWN_WALK);
  });

  // WHIT-698 — these go through findOffenders (built on testFiles), so they import that instead.
  it.each(['sharedLoadedWait.logic.test.ts', 'sharedQueryWaits.screen.test.tsx'])(
    '%s does not walk the test tree itself',
    (guard) => {
      const code = stripComments(readFileSync(join(TESTS_DIR, guard), 'utf8'));
      expect(code).not.toMatch(LOCAL_WALKER);
      expect(code).not.toMatch(OWN_WALK);
    },
  );
});
