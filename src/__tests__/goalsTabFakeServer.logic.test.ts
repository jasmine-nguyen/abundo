// WHIT-685 slice 2 — the 8 Goals tab suites run the real screen data code over the fake server,
// are off the queries-mock allow-list and are pinned on the moved-suites expect( count list.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const GOALS_TAB_FILES = [
  'goalsHub.screen.test.tsx',
  'goalsHubEdges.screen.test.tsx',
  'goalsHubOverpaid.screen.test.tsx',
  'goalsHubOwing.screen.test.tsx',
  'goalsHubPayoffFloor.screen.test.tsx',
  'goalsHubPureHero.screen.test.tsx',
  'goalsCheckpointCelebration.screen.test.tsx',
  'goalsCheckpointCelebrationPaydown.screen.test.tsx',
];

const QUERIES_MOCK = /^\s*jest\.(mock|doMock)\(\s*['"](\.\.\/)+(src\/)?queries['"]/m;

const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

function allowList(): string {
  const guard = source('noQueriesMock.logic.test.ts');
  const start = guard.indexOf('const ALLOWED');
  return guard.slice(start, guard.indexOf(']);', start));
}

describe('the Goals tab suites run on the fake server', () => {
  it('each Goals tab suite draws the real screen over installFakeServer() instead of faking ../queries', () => {
    const notMoved = GOALS_TAB_FILES.filter((file) => {
      const text = source(file);
      return QUERIES_MOCK.test(text) || !text.includes('installFakeServer()') || !text.includes('renderWithQueries');
    });
    expect(notMoved).toEqual([]);
  });

  it('each Goals tab suite is off the queries-mock allow-list and on the moved-suites expect( count list', () => {
    const allowed = allowList();
    const counts = source('noAutoMockApi.logic.test.ts');
    const stillAllowed = GOALS_TAB_FILES.filter((file) => allowed.includes(`'${file}'`));
    const uncounted = GOALS_TAB_FILES.filter((file) => !new RegExp(`'${file.replace(/\./g, '\\.')}':\\s*[1-9]\\d*,`).test(counts));
    expect({ stillAllowed, uncounted }).toEqual({ stillAllowed: [], uncounted: [] });
  });
});
