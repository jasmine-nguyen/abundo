// WHIT-433 / WHIT-567 — regression guard for the flaky-screen-suite fix.
//
// The fix raises the per-test ceiling to 15000ms (from Jest's 5000ms default) for the `screen`
// project, so heavy full-provider RN-animation suites don't time out under the slow v8-coverage
// run. The real proof (the sharded-coverage repro) is far too slow to run on every CI merge, so
// this cheap `logic` test is the backstop: if a future edit removes, lowers, OR comments out the
// ceiling, the flake comes back silently — this reddens instead.
//
// WHIT-567: the ceiling is NOT a project-level `testTimeout` in jest.config.js — Jest 30 silently
// ignores that — it is `jest.setTimeout(15000)` in jest.setup.js, which is the screen project's
// setupFilesAfterEnv. So this guard checks BOTH halves of the working mechanism: (a) the screen
// project wires jest.setup.js, and (b) jest.setup.js carries an ACTIVE jest.setTimeout >= 15000.
// Either alone is insufficient — the wiring is useless without the line, the line is dead without
// the wiring.
import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from '@jest/globals';

// The production config, required directly — asserting the shipped value, not a fixture.
// __dirname is src/__tests__, so the repo-root config is two levels up.
const jestConfig = require('../../jest.config.js') as {
  projects: Array<{ displayName?: string; setupFilesAfterEnv?: string[]; testTimeout?: number }>;
};

// Jest's built-in default; anything at or below this is what caused WHIT-433.
const JEST_DEFAULT_TIMEOUT_MS = 5000;
// The floor the fix committed to — proven green under the sharded coverage run (the worst case).
const SCREEN_TIMEOUT_FLOOR_MS = 15000;

const screen = jestConfig.projects.find((project) => project.displayName === 'screen');
const logic = jestConfig.projects.find((project) => project.displayName === 'logic');

// jest.setup.js is not require-able in this node env (it calls jest.mock / RN globals), so read it
// as text. Find an ACTIVE jest.setTimeout(...) call: a line whose trimmed form starts with the call
// (not "//" or "*"), so a commented-out line does NOT satisfy the guard. Returns the ms, or null.
function activeSetupTimeoutMs(): number | null {
  const source = readFileSync(join(__dirname, '../../jest.setup.js'), 'utf8');
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//') || line.startsWith('*')) continue;
    const match = line.match(/^jest\.setTimeout\(\s*(\d+)\s*\)/);
    if (match) return Number(match[1]);
  }
  return null;
}

describe('WHIT-567: the 15s screen ceiling lives in the screen-only setup file', () => {
  it('the screen project wires jest.setup.js as setupFilesAfterEnv', () => {
    expect(screen).toBeDefined();
    expect(screen?.setupFilesAfterEnv ?? []).toContain('<rootDir>/jest.setup.js');
  });

  it('jest.setup.js sets an ACTIVE jest.setTimeout at or above the 15000ms floor', () => {
    // Fail-on-revert: delete, lower, or comment out the jest.setTimeout line and this reds.
    const timeout = activeSetupTimeoutMs();
    expect(timeout).not.toBeNull();
    expect(timeout as number).toBeGreaterThanOrEqual(SCREEN_TIMEOUT_FLOOR_MS);
  });
});

describe('WHIT-433: the fix is scoped to screen and does not slow the logic gate', () => {
  // The logic project is the fast regression gate; it must not inherit a slow ceiling that would
  // hide a genuinely hung pure-function test. It must neither set an inflated testTimeout nor pull
  // in jest.setup.js (which would apply the 15s ceiling to it).
  it('the logic project does NOT set an inflated testTimeout', () => {
    expect(logic).toBeDefined();
    expect(logic?.testTimeout ?? JEST_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(JEST_DEFAULT_TIMEOUT_MS);
  });

  it('the logic project does NOT load the screen setup file', () => {
    expect(logic?.setupFilesAfterEnv ?? []).not.toContain('<rootDir>/jest.setup.js');
  });
});
