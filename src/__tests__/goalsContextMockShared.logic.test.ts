// WHIT-752 — the Goals suites share one ../context fake (support/goalsScreen goalsContextMockModule)
// instead of each keeping its own copy of the factory that returns only openGoalBalance.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

// Built from pieces so this file never matches itself.
const KEY = ['open', 'Goal', 'Balance'].join('');
const INLINE_COPY = new RegExp(`useAppContext:\\s*\\(\\)\\s*=>\\s*\\(\\{\\s*${KEY}:\\s*[\\w.]+(\\(\\))?\\s*\\}\\)`);
const HELPER_FILE = 'support/goalsScreen.tsx';
const SHARED_CALL = 'goalsContextMockModule(';

const GOALS_SUITES = [
  'goalPace.screen.test.tsx',
  'goalPace.edges.screen.test.tsx',
  'goalsHubEdges.screen.test.tsx',
  'goalsHubOverpaid.screen.test.tsx',
  'goalsHubOwing.screen.test.tsx',
  'goalsHubPureHero.screen.test.tsx',
  'goalsHubReads.qa.screen.test.tsx',
  'goalsHub.screen.test.tsx',
  'goalsHubPayoffFloor.screen.test.tsx',
  'goalsCheckpointCelebration.screen.test.tsx',
  'goalsCheckpointCelebrationPaydown.screen.test.tsx',
  'goalsCelebrationEdges.qa.screen.test.tsx',
  'goalsCelebrationMemory.screen.test.tsx',
];

const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8');

describe('Goals suites share one context fake', () => {
  it('no test file keeps its own copy of the openGoalBalance-only context fake', () => {
    const copies = testFiles(__dirname).filter((file) => file !== HELPER_FILE && INLINE_COPY.test(read(file)));
    expect(copies).toEqual([]);
  });

  it('every Goals suite mocks ../context with the shared fake', () => {
    expect(GOALS_SUITES.filter((file) => !read(file).includes(SHARED_CALL))).toEqual([]);
  });
});
