// WHIT-786 QA — the card's slice 1 promise: "the guard test fails if any of that setup is copied
// back", and that setup includes the fake keychain / Google / password builders. The main guard
// (authTestSetupShared) covers the key names, nowSec, loadAuth and fakeSession; this covers a
// hand-written native-module mock factory pasted back in place of support/authModule's builders.
import { describe, it, expect } from '@jest/globals';
import { basename } from 'path';
import { findOffenders } from './support/sourceScan';

// [A1] Built from parts so this file never contains the text it hunts for.
const MODULES = ['expo-secure-store', 'expo-auth-session', 'amazon-cognito-identity-js'];
const handWritten = (module: string) =>
  new RegExp(`jest\\.mock\\(\\s*['"]${module}['"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\s*\\{`);

// authForgotPassword models forgotPassword/confirmPassword and a constructor spy that cognitoMock
// doesn't (plan, critic tweaks) — it keeps its own Cognito mock on purpose.
const ALLOWED: Record<string, string[]> = {
  'amazon-cognito-identity-js': ['authForgotPassword.logic.test.ts'],
};

describe('[A1] sign-in suites build native-module mocks from support/authModule', () => {
  it.each(MODULES)('no test file hand-writes a %s mock factory', (module) => {
    const allowed = new Set(['support/authModule.ts', basename(__filename), ...(ALLOWED[module] ?? [])]);
    expect(findOffenders((line) => handWritten(module).test(line), allowed)).toEqual([]);
  });
});
