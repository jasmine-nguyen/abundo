// WHIT-683 — the cache-in-act guard lives in one file, so a change to it can't silently miss a copy
// and the test folder is scanned once.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, sep } from 'path';

const TESTS_DIR = __dirname;
const SRC_DIR = join(TESTS_DIR, '..');
// Built from parts so this file never matches what it hunts for.
const DELETED_GUARD = 'cacheRefresh' + 'Anywhere' + 'InAct';
const GUARD_MATCHER = 'CACHE_CALL' + '.test(';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (entry === 'node_modules') continue;
    if (statSync(abs).isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.tsx?$/.test(entry) && entry !== basename(__filename)) out.push(abs);
  }
  return out;
}

const relativeToTests = (abs: string): string => relative(TESTS_DIR, abs).split(sep).join('/');

describe('the cache-in-act guard lives in one file', () => {
  it('only cacheRefreshInAct.logic.test.ts scans act bodies for cache calls', () => {
    const guards = sourceFiles(TESTS_DIR)
      .filter((abs) => readFileSync(abs, 'utf8').includes(GUARD_MATCHER))
      .map(relativeToTests);
    expect(guards).toEqual(['cacheRefreshInAct.logic.test.ts']);
  });

  it('nothing under src still names the removed duplicate guard', () => {
    const mentions = sourceFiles(SRC_DIR)
      .filter((abs) => readFileSync(abs, 'utf8').includes(DELETED_GUARD))
      .map(relativeToTests);
    expect(mentions).toEqual([]);
  });
});
