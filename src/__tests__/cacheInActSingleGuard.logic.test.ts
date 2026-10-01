// WHIT-683 — the cache-in-act guard lives in one file, so a change to it can't silently miss a copy
// and the test folder is scanned once.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { testFiles } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SRC_DIR = join(TESTS_DIR, '..');
// Built from parts so this file never matches what it hunts for.
const DELETED_GUARD = 'cacheRefresh' + 'Anywhere' + 'InAct';
const GUARD_MATCHER = 'CACHE_CALL' + '.test(';

const filesUnder = (root: string) => testFiles(root).filter((file) => !file.endsWith(basename(__filename)));

describe('the cache-in-act guard lives in one file', () => {
  it('only cacheRefreshInAct.logic.test.ts scans act bodies for cache calls', () => {
    const guards = filesUnder(TESTS_DIR).filter((file) => readFileSync(join(TESTS_DIR, file), 'utf8').includes(GUARD_MATCHER));
    expect(guards).toEqual(['cacheRefreshInAct.logic.test.ts']);
  });

  it('nothing under src still names the removed duplicate guard', () => {
    const mentions = filesUnder(SRC_DIR).filter((file) => readFileSync(join(SRC_DIR, file), 'utf8').includes(DELETED_GUARD));
    expect(mentions).toEqual([]);
  });
});
