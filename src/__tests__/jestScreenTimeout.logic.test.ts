// WHIT-433 — regression guard for the flaky-screen-suite fix.
//
// The fix is a SINGLE config line: the `screen` jest project raises testTimeout to 15000
// (from Jest's 5000ms default) so heavy full-provider RN-animation suites don't time out
// under the slow v8-coverage run. The real proof (the flaky sharded-coverage repro) is far
// too slow to run on every CI merge, so this cheap `logic` test is the backstop: if a future
// edit deletes or lowers that line, the flake comes back silently — this reddens instead.
//
// It reads the ACTUAL exported jest config (require, not a re-implemented copy), finds the
// screen project by displayName, and asserts its real testTimeout. Fail-on-revert: drop the
// line (or set it below the floor) and this test fails.
import { describe, it, expect } from '@jest/globals';

// The production config, required directly — asserting the shipped value, not a fixture.
// __dirname is src/__tests__, so the repo-root config is two levels up.
const jestConfig = require('../../jest.config.js') as {
  projects: Array<{ displayName?: string; testTimeout?: number }>;
};

// Jest's built-in default; anything at or below this is what caused WHIT-433.
const JEST_DEFAULT_TIMEOUT_MS = 5000;
// The floor the fix committed to — proven green under runInBand+coverage (the worst case).
const SCREEN_TIMEOUT_FLOOR_MS = 15000;

const screen = jestConfig.projects.find((project) => project.displayName === 'screen');

describe('WHIT-433: the screen jest project keeps its raised testTimeout', () => {
  it('the screen project still exists and is found by displayName', () => {
    expect(screen).toBeDefined();
  });

  it("screen.testTimeout is above Jest's 5000ms default (the flake threshold)", () => {
    expect(screen?.testTimeout).toBeGreaterThan(JEST_DEFAULT_TIMEOUT_MS);
  });

  it('screen.testTimeout is at or above the committed 15000ms floor', () => {
    expect(typeof screen?.testTimeout).toBe('number');
    expect(screen?.testTimeout).toBeGreaterThanOrEqual(SCREEN_TIMEOUT_FLOOR_MS);
  });
});

describe('WHIT-433: the fix is scoped to screen and does not slow the logic gate', () => {
  // The logic project is the fast regression gate; it must not inherit a slow ceiling that
  // would hide a genuinely hung pure-function test. Leaving it unset (default) is correct.
  it('the logic project does NOT set an inflated testTimeout', () => {
    const logic = jestConfig.projects.find((project) => project.displayName === 'logic');
    expect(logic).toBeDefined();
    expect(logic?.testTimeout ?? JEST_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(
      JEST_DEFAULT_TIMEOUT_MS,
    );
  });
});
