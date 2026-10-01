// WHIT-677 — screen tests refresh or write the query cache through refreshInAct
// (support/renderWithQueries.tsx), never directly inside act(). A direct cache call inside act lets the
// query library's setTimeout(0) notification flush land after act ends → React logs an act warning →
// under coverage that stalls past waitFor's 1s limit → flaky CI.
// Limit: only catches a cache call that is the first statement in the act body ([^};]*? stops at the
// first `;` or `}`). Fail-on-revert: put one direct cache call back inside act and this goes red, naming the file.
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, sep } from 'path';

const TESTS_DIR = __dirname;
const SUPPORT_DIR = join(TESTS_DIR, 'support');
const CACHE_METHODS = ['invalidate', 'refetch', 'reset', 'remove'].map((verb) => verb + 'Queries').concat('set' + 'QueryData');
// Built from parts so this file never contains the pattern it hunts for.
const DIRECT_CACHE_CALL_IN_ACT = new RegExp(
  '\\b' + 'act' + '\\(\\s*(async\\s*)?\\(\\)\\s*=>\\s*\\{?[^};]*?\\b\\w+\\.(' + CACHE_METHODS.join('|') + ')(<[^>]*>)?\\(',
);

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
  ])('flags a direct cache call inside act: %s', (_name, source) => {
    expect(DIRECT_CACHE_CALL_IN_ACT.test(source)).toBe(true);
  });

  it.each([
    ['refreshInAct', `await ${REFRESH_IN_ACT}() => client.${'invalidate' + 'Queries'}({ queryKey: ['k'] }));`],
    ['a non-cache call inside act', `${ACT}() => { pending = result.current.applyCategory('one'); });`],
    ['a cache write outside act', `client.${'set' + 'QueryData'}(['k'], 1);`],
    ['a cache call after the first statement (documented limit)', `${ACT}async () => { foo(); client.${'invalidate' + 'Queries'}(); });`],
  ])('does not flag %s', (_name, source) => {
    expect(DIRECT_CACHE_CALL_IN_ACT.test(source)).toBe(false);
  });

  it('no test file outside support/ calls the query cache directly inside act', () => {
    const offenders = testFiles(TESTS_DIR)
      .filter((abs) => DIRECT_CACHE_CALL_IN_ACT.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(TESTS_DIR, abs).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
