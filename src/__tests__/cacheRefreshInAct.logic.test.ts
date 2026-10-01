// WHIT-677 — screen tests refresh or write the query cache through refreshInAct
// (support/renderWithQueries.tsx), never directly inside act(). A direct cache call inside act lets the
// query library's setTimeout(0) notification flush land after act ends → React logs an act warning →
// under coverage that stalls past waitFor's 1s limit → flaky CI.
// WHIT-681 — reads each act(...) body whole (comments stripped, brackets matched, strings skipped), so a
// cache call is caught anywhere in the body, not just as the first statement.
// Fail-on-revert: put one direct cache call back inside act and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, sep } from 'path';
import { matchingBrace, stripComments } from './support/sourceScan';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
// Built from parts so this file never contains the pattern it hunts for.
const CACHE_METHODS = ['invalidate', 'refetch', 'reset', 'remove'].map((verb) => verb + 'Queries').concat('set' + 'QueryData');
const CACHE_CALL = new RegExp('\\.\\s*(' + CACHE_METHODS.join('|') + ')\\b');

function callsCacheInsideAct(source: string): boolean {
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

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (abs === SUPPORT_DIR) continue;
    if (statSync(abs).isDirectory()) out.push(...testFiles(abs));
    else if (/\.tsx?$/.test(entry) && entry !== basename(__filename)) out.push(abs);
  }
  return out;
}

const ACT = 'act' + '(';
const REFRESH_IN_ACT = 'refreshIn' + 'Act(';

describe('cache refreshes in screen tests go through refreshInAct', () => {
  it.each([
    ['sync block', `${ACT}() => { client.${'set' + 'QueryData'}(['k'], 1); });`],
    ['async await', `await ${ACT}async () => { await client.${'invalidate' + 'Queries'}({ queryKey: ['k'] }); });`],
    ['expression body', `${ACT}() => client.${'refetch' + 'Queries'}({ queryKey: ['k'] }));`],
    ['generic call', `${ACT}() => { client.${'set' + 'QueryData'}<Foo[]>(['k'], []); });`],
    ['multi-line block', `${ACT}() => {\n  queryClient.${'remove' + 'Queries'}({ queryKey: ['k'] });\n});`],
    ['reset', `${ACT}async () => { await queryClient.${'reset' + 'Queries'}(); });`],
    ['a cache call after the first statement', `${ACT}async () => { foo(); client.${'invalidate' + 'Queries'}(); });`],
    ['a third statement, multi-line', `${ACT}async () => {\n  foo();\n  bar(1);\n  client.${'refetch' + 'Queries'}();\n});`],
    ['a write mid-save', `await ${ACT}async () => { const p = save(); client.${'set' + 'QueryData'}(['k'], []); ok = await p; });`],
  ])('flags a direct cache call inside act: %s', (_name, source) => {
    expect(callsCacheInsideAct(source)).toBe(true);
  });

  it.each([
    ['refreshInAct', `await ${REFRESH_IN_ACT}() => client.${'invalidate' + 'Queries'}({ queryKey: ['k'] }));`],
    ['a non-cache call inside act', `${ACT}() => { pending = result.current.applyCategory('one'); });`],
    ['a cache write outside act', `client.${'set' + 'QueryData'}(['k'], 1);`],
    ['a cache call after act closes', `${ACT}() => { foo(); }); client.${'set' + 'QueryData'}(['k'], 1);`],
    ['an apostrophe in a comment inside act', `${ACT}() => {\n  // don't\n  foo();\n}); client.${'set' + 'QueryData'}(['k'], 1);`],
  ])('does not flag %s', (_name, source) => {
    expect(callsCacheInsideAct(source)).toBe(false);
  });

  it('no test file outside support/ calls the query cache directly inside act', () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((abs) => callsCacheInsideAct(readFileSync(abs, 'utf8')))
      .map((abs) => relative(TESTS_DIR, abs).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
