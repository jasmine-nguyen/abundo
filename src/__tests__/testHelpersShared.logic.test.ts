// WHIT-756 — the copied test helpers live once in support/: invalidatedKeys and the act-based
// flush in support/queryClient.ts, the 20-tick drainMicrotasks in support/fakeServer.ts.
// Fail-on-revert: put a local copy back into any test file and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { testFiles } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
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
  it('support/queryClient.ts exports invalidatedKeys and flush', () => {
    const source = readFileSync(join(SUPPORT_DIR, 'queryClient.ts'), 'utf8');
    expect(source).toMatch(new RegExp(`export (function|const) ${KEYS_NAME}\\b`));
    expect(source).toMatch(/export (async )?(function|const) flush\b/);
  });

  it('support/fakeServer.ts exports drainMicrotasks', () => {
    const source = readFileSync(join(SUPPORT_DIR, 'fakeServer.ts'), 'utf8');
    expect(source).toMatch(/export (async )?(function|const) drainMicrotasks\b/);
  });

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

  it('the unused auth stand-in is gone', () => {
    expect(read('support/authMock.ts')).not.toMatch(new RegExp('useIsAuthed' + 'Mock'));
  });

  it.each([
    ['support/alertSpy.ts', 'AlertButton'],
    ['support/sourceScan.ts', 'CODE_FILE'],
    ['support/budgetsScreen.tsx', 'sidePaddingOf'],
    ['support/goalsScreen.tsx', 'GOALS_HUB_DEFAULTS'],
    ['support/openOverlays.tsx', 'OverlaysOverScreens'],
  ])('%s keeps %s private', (file, name) => {
    const source = read(file);
    expect(source).toMatch(new RegExp(`\\b${name}\\b`));
    expect(source).not.toMatch(new RegExp(`export\\s+(async\\s+)?(type|interface|function|const|let)\\s+${name}\\b`));
  });
});
