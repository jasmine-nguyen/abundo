// WHIT-756 — the copied test helpers live once in support/: invalidatedKeys and the act-based
// flush in support/queryClient.ts, the 20-tick drainMicrotasks in support/fakeServer.ts.
// Fail-on-revert: put a local copy back into any test file and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { testFiles } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SELF = basename(__filename);
const read = (file: string) => readFileSync(join(TESTS_DIR, file), 'utf8');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Built from parts so this file never contains the literals it hunts for.
const KEYS_NAME = 'invalidated' + 'Keys';
const LOCAL_KEYS = new RegExp(`(function ${KEYS_NAME}\\b|const ${KEYS_NAME}\\s*=)`);
const KEYS_BODY = new RegExp(escape('queryKey: string[] }).' + 'queryKey[0]'));
const ACT_FLUSH_BODY = new RegExp(
  escape('act(async () => { for (let i = 0; i < 5; i += 1) ' + 'await Promise.resolve(); })'),
);
// A named helper wrapping the 20-tick loop — not a one-off inline act(...) loop in a test body.
const TICK_FLUSH_BODY = new RegExp(
  '(function \\w+\\([^)]*\\)[^{]*|const \\w+\\s*=\\s*async\\s*\\([^)]*\\)[^{]*=>\\s*)\\{\\s*' + escape('for (let i = 0; i < 20; i++) ' + 'await Promise.resolve();'),
);

function offenders(pattern: RegExp, home: string): string[] {
  return testFiles(TESTS_DIR)
    .filter((file) => file !== home && file !== SELF)
    .filter((file) => pattern.test(read(file)));
}

describe('test helpers are shared, not copied', () => {
  it('no test file defines its own invalidatedKeys or rebuilds the key list inline', () => {
    expect(offenders(LOCAL_KEYS, 'support/queryClient.ts')).toEqual([]);
    expect(offenders(KEYS_BODY, 'support/queryClient.ts')).toEqual([]);
  });

  it('no test file copies the act-based flush', () => {
    expect(offenders(ACT_FLUSH_BODY, 'support/queryClient.ts')).toEqual([]);
  });

  it('no test file copies the 20-tick microtask drain', () => {
    expect(offenders(TICK_FLUSH_BODY, 'support/fakeServer.ts')).toEqual([]);
  });
});
