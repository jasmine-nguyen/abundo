// Guard for support/authModule.ts: every suite that uses the shared auth setup gets its Cognito env
// vars and fake fetch from the helpers there, never from a hand-copied block of its own.
import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = __dirname;
const SELF = 'authModule.logic.test.ts';

// Built from pieces so this file never matches its own patterns.
const ENV_PREFIX = 'process.env.' + 'EXPO_PUBLIC_COGNITO_';
const FETCH_CAST = 'globalThis as unknown as ' + '{ fetch';
// auth.logic deliberately unsets the client id to test the missing-var error.
const ALLOWED = new Set(['auth.logic.test.ts: delete ' + ENV_PREFIX + 'APP_CLIENT_ID;']);

function authSuites(): string[] {
  return readdirSync(TESTS_DIR)
    .filter((name) => /\.test\.tsx?$/.test(name) && name !== SELF)
    .filter((name) => readFileSync(join(TESTS_DIR, name), 'utf8').includes('support/authModule'));
}

describe('auth suites share the SRP-refresh setup from support/authModule', () => {
  it('no auth suite sets Cognito env vars or swaps global fetch on its own', () => {
    const suites = authSuites();
    expect(suites.length).toBeGreaterThanOrEqual(10);

    const copies: string[] = [];
    for (const name of suites) {
      readFileSync(join(TESTS_DIR, name), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const code = line.trim();
          if (ALLOWED.has(`${name}: ${code}`)) return;
          if (code.includes(ENV_PREFIX) || code.includes(FETCH_CAST)) copies.push(`${name}:${index + 1}: ${code}`);
        });
    }

    expect(copies).toEqual([]);
  });
});
