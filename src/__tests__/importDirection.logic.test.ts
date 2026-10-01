// WHIT-630: imports run one way — context.tsx → queries.ts → api.ts — with the pure pieces
// (data shapes, model converters, pay clock, budget maths, cache keys) in leaf files. With the
// loop gone, context.tsx and transactionCache.ts use the named cache keys, never typed-out arrays.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');
const stripLineComments = (source: string) => source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
// A real import/export statement from the given module — not a mention of it in a comment.
const importsFrom = (source: string, mod: string) =>
  new RegExp(`^\\s*(import|export)[^;]*from\\s+['"]${mod.replace(/[./]/g, '\\$&')}['"]`, 'm').test(source);

const LEAF_FILES = ['types.ts', 'model.ts', 'payCycle.ts', 'budgetMath.ts', 'queryKeys.ts'];
const MUST_NOT_IMPORT_CONTEXT = [...LEAF_FILES, 'queries.ts', 'api.ts', 'transactionCache.ts', 'categoryColors.ts'];

// The cache keys the card names; unioned with whatever queryKeys.ts exports so a key
// dropped from queryKeys.ts can't quietly escape the check.
const KNOWN_KEY_NAMES = [
  'payCycle', 'budgets', 'breakdown', 'categories', 'rules', 'goals', 'loanFacts', 'milestones',
  'transactions', 'transactionsSearch', 'transactionsRecent', 'uncategorizedCount',
  'uncategorizedFeed', 'uncategorizedMerchants', 'filingSuggestions', 'budgetTransactions',
  'categoryTransactions',
];

describe('module import direction', () => {
  it.each(LEAF_FILES)('the leaf file %s exists', (file) => {
    expect(fs.existsSync(path.join(SRC, file))).toBe(true);
  });

  it.each(MUST_NOT_IMPORT_CONTEXT)('%s does not import ./context', (file) => {
    expect(importsFrom(read(file), './context')).toBe(false);
  });

  it('api.ts does not import ./queries', () => {
    expect(importsFrom(read('api.ts'), './queries')).toBe(false);
  });

  it('context.tsx takes its cache keys from ./queryKeys', () => {
    expect(importsFrom(read('context.tsx'), './queryKeys')).toBe(true);
  });
});

describe('cache keys are named, not typed out', () => {
  const keyNames = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = Object.values(require('../queryKeys') as Record<string, unknown>)
      .filter((value): value is readonly unknown[] => Array.isArray(value))
      .map((key) => String(key[0]));
    return Array.from(new Set([...KNOWN_KEY_NAMES, ...exported]));
  };

  it.each(['context.tsx', 'transactionCache.ts'])('%s has no hand-typed cache-key arrays or key comparisons', (file) => {
    const code = stripLineComments(read(file));
    const found = keyNames().filter((name) =>
      [`['${name}'`, `["${name}"`, `=== '${name}'`, `=== "${name}"`].some((literal) => code.includes(literal)),
    );
    expect(found).toEqual([]);
  });
});

describe('the spendable formula exists once', () => {
  it('context.tsx no longer spells out `available ?? (parts-sum)`', () => {
    const code = stripLineComments(read('context.tsx'));
    expect(code).not.toMatch(/\.available\s*\?\?/);
  });
});
