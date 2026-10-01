// WHIT-681 — the cache-in-act guard must see a cache call anywhere in an act body, not just first.
// matchingBrace (support/sourceScan.ts) is generalised to any open/close pair so the act body can be
// read whole; every test file outside support/ must then hold no cache call inside any act body.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, sep } from 'path';
import { matchingBrace, stripComments } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
// The guard's own samples deliberately hold offending source.
const GUARD_FILE = 'cacheRefreshInAct.logic.test.ts';
const CACHE_METHODS = ['invalidate', 'refetch', 'reset', 'remove'].map((verb) => verb + 'Queries').concat('set' + 'QueryData');
const CACHE_CALL = new RegExp('\\.\\s*(' + CACHE_METHODS.join('|') + ')\\b');
const ACT = 'act' + '(';

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (abs === SUPPORT_DIR) continue;
    if (statSync(abs).isDirectory()) out.push(...testFiles(abs));
    else if (/\.tsx?$/.test(entry) && entry !== basename(__filename) && entry !== GUARD_FILE) out.push(abs);
  }
  return out;
}

function cacheCallInsideAct(source: string): boolean {
  const code = stripComments(source);
  const opener = new RegExp('\\b' + 'act' + '\\(', 'g');
  for (let match = opener.exec(code); match; match = opener.exec(code)) {
    const open = match.index + 3;
    const close = matchingBrace(code, open, '(', ')');
    if (close === -1) continue;
    if (CACHE_CALL.test(code.slice(open, close))) return true;
  }
  return false;
}

describe('matchingBrace reads a whole act body', () => {
  it('finds the paren closing act, past a later statement and a paren inside a string', () => {
    const source = `${ACT}async () => { foo(')'); client.${'set' + 'QueryData'}(['k'], []); ok = await p; }); after();`;
    const close = matchingBrace(source, 3, '(', ')');
    expect(source.slice(close)).toBe('); after();');
  });

  it('still matches braces by default', () => {
    expect(matchingBrace('a: { b: { c: 1 }, d: "}" } tail', 3)).toBe(25);
  });
});

describe('cache calls anywhere inside act are caught', () => {
  it('flags a cache call that is not the first statement', () => {
    const source = `await ${ACT}async () => {\n  const p = save();\n  client.${'set' + 'QueryData'}(['k'], []);\n  ok = await p;\n});`;
    expect(cacheCallInsideAct(source)).toBe(true);
  });

  it('no test file outside support/ calls the query cache anywhere inside act', () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((abs) => cacheCallInsideAct(readFileSync(abs, 'utf8')))
      .map((abs) => relative(TESTS_DIR, abs).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
