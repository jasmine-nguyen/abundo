// WHIT-685 slice 3 — the goal add/edit form suite runs the real screen data code over the fake
// server (goals, transactions and balances), is off the queries-mock allow-list, is pinned on the
// moved-suites expect( count list, and has lost only its layout-only tests.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const GOAL_FORM_FILE = 'goalEdit.screen.test.tsx';

const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowList(): string {
  const guard = source('noQueriesMock.logic.test.ts');
  const start = guard.indexOf('const ALLOWED');
  return guard.slice(start, guard.indexOf(']);', start));
}

describe('the goal add/edit form suite runs on the fake server', () => {
  it('draws the real goal form over installFakeServer(), seeding goals, transactions and balances instead of faking ../queries', () => {
    const text = source(GOAL_FORM_FILE);
    const problems: string[] = [];
    if (QUERIES_MOCK.test(text)) problems.push('still mocks ../queries');
    if (!text.includes('installFakeServer()')) problems.push('no installFakeServer()');
    if (!text.includes('useTestQueryClient()')) problems.push('no useTestQueryClient()');
    if (!text.includes('renderWithQueries')) problems.push('no renderWithQueries');
    if (!text.includes('authMockModule()')) problems.push('no auth mock');
    for (const path of ['/goals', '/transactions', '/accounts/balances']) {
      if (!text.includes(`'${path}'`)) problems.push(`never seeds ${path}`);
    }
    expect(problems).toEqual([]);
  });

  it('is off the queries-mock allow-list and on the moved-suites expect( count list', () => {
    const stillAllowed = allowList().includes(`'${GOAL_FORM_FILE}'`);
    const counted = /'goalEdit\.screen\.test\.tsx':\s*[1-9]\d*,/.test(source('noAutoMockApi.logic.test.ts'));
    expect({ stillAllowed, counted }).toEqual({ stillAllowed: false, counted: true });
  });

  it('drops only the one-row layout tests and keeps the keyboard and reflow behaviour tests', () => {
    const text = source(GOAL_FORM_FILE);
    const deleted = [
      'lays the label and amount out on one row',
      'lays every rung out as its own horizontal row',
    ].filter((title) => text.includes(title));
    const kept = [
      'Save/Delete stay reachable',
      'the amount input still requests the decimal keyboard after the reflow',
      'a long label leaves both inputs independently editable (no state bleed)',
      're-seeds the form when the goals cache resolves a beat after mount',
      'save is a no-op while the edited goal is still loading',
      'a background cache refetch does NOT clobber what the user is mid-editing',
      'a background refetch does NOT clobber a rung the user is mid-editing',
    ].filter((title) => !text.includes(title));
    expect({ stillPresent: deleted, missing: kept }).toEqual({ stillPresent: [], missing: [] });
  });
});
