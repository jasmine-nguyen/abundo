// WHIT-674 — screen tests share one React Query test client (support/queryClient.ts) instead of
// each file building its own copy. Fail-on-revert: put a local QueryClient constructor call back into any
// test file and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
// Built from parts so this file never contains the literal it hunts for.
const LOCAL_CLIENT = new RegExp('new ' + 'QueryClient\\(');

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (abs === SUPPORT_DIR) continue;
    if (statSync(abs).isDirectory()) out.push(...testFiles(abs));
    else if (/\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

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
      .filter((abs) => LOCAL_CLIENT.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(TESTS_DIR, abs).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
