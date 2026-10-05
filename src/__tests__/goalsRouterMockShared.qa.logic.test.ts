// WHIT-751 QA — gaps the implementer's guard (goalsRouterMockShared.logic.test.ts) doesn't cover:
// the mortgage and milestone screen tests the sign-off answer (Q2) brought into scope, and the
// leftover empty `import {} from './support/routerMock'` lines the conversion left behind.
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { stripComments } from './support/sourceScan';

const TESTS_DIR = __dirname;
const read = (file: string) => stripComments(readFileSync(join(TESTS_DIR, file), 'utf8'));

// Built from parts so this file never contains the literals it hunts for.
const SHARED_ROUTER = new RegExp(
  "jest\\.mock\\(\\s*'expo-" + "router',\\s*\\(\\)\\s*=>\\s*require\\('\\./support/routerMock'\\)\\.routerMockModule\\(",
);
const EMPTY_IMPORT = new RegExp('^\\s*import\\s*\\{\\s*\\}\\s*from', 'm');

describe('WHIT-751 QA: shared router reaches every Goals-area screen test', () => {
  // [A1] (P0) Sign-off Q2: "the mortgage page, milestones" also switch to the shared router.
  it.each(['mortgage.screen.test.tsx', 'milestone.screen.test.tsx'])(
    '%s mocks expo-router with the shared routerMockModule',
    (file) => {
      expect(read(file)).toMatch(SHARED_ROUTER);
    },
  );

  // [A2] (P1) No test file keeps an empty `import {} from …` left over from the swap.
  it('no test file has an empty named import', () => {
    const offenders = readdirSync(TESTS_DIR)
      .filter((file) => /\.test\.tsx?$/.test(file))
      .filter((file) => EMPTY_IMPORT.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
