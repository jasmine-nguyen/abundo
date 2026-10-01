// WHIT-674 — screen tests share one React Query test client (support/queryClient.ts) instead of
// each file building its own copy. Fail-on-revert: put a local QueryClient constructor call back into any
// test file and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { testFiles } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
// Built from parts so this file never contains the literal it hunts for.
const LOCAL_CLIENT = new RegExp('new ' + 'QueryClient\\(');

describe('screen tests share one query-client helper', () => {
  it('the shared helper provides makeClient, wrapper and pause', () => {
    const helper = join(SUPPORT_DIR, 'queryClient.ts');
    expect(existsSync(helper)).toBe(true);
    const source = readFileSync(helper, 'utf8');
    expect(source).toMatch(/export (function|const) makeClient\b/);
    expect(source).toMatch(/export (function|const) wrapper\b/);
    expect(source).toMatch(/export (function|const) pause\b/);
  });

  it('no test file outside support/ builds its own QueryClient', () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((file) => !file.startsWith('support/'))
      .filter((file) => LOCAL_CLIENT.test(readFileSync(join(TESTS_DIR, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
