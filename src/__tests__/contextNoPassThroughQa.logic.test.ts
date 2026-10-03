// WHIT-630 slice 2 (QA): context.tsx must not hand on the moved pieces in ANY form — not just
// `export … from './model'`, but also a bare `export { cycleName }` of an imported binding or a
// wrapper re-declared under the old name. The moved pieces stay reachable from their own files.
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import * as context from '../context';
import * as model from '../model';
import * as payCycle from '../payCycle';
import * as budgetMath from '../budgetMath';

const RUNTIME_MOVED: Record<string, Record<string, unknown>> = {
  '../model': model as unknown as Record<string, unknown>,
  '../payCycle': payCycle as unknown as Record<string, unknown>,
  '../budgetMath': budgetMath as unknown as Record<string, unknown>,
};
const MOVED_RUNTIME_NAMES: [string, string][] = [
  ['../model', 'toCategory'], ['../model', 'toBudget'], ['../model', 'toRule'],
  ['../model', 'EMPTY_LOAN_FACTS'], ['../model', 'loanFactsReady'], ['../model', 'UNCATEGORIZED_KEY'],
  ['../model', 'EARNED_KEY'], ['../model', 'INCOME_KEY'], ['../model', 'ROLLUP_KEY'],
  ['../model', 'readRollup'], ['../model', 'readIncomeSources'],
  ['../payCycle', 'cycleName'], ['../payCycle', 'cycleClock'],
  ['../payCycle', 'cycleClockView'], ['../payCycle', 'elapsedFrac'],
  ['../budgetMath', 'availableToSpend'], ['../budgetMath', 'paceTarget'],
];
const MOVED_TYPE_NAMES = ['Bucket', 'Category', 'Transaction', 'Budget', 'Rule', 'RuleWrite', 'HomeLoanState'];

const contextSource = fs.readFileSync(path.join(__dirname, '..', 'context.tsx'), 'utf8');
const stripLineComments = (source: string) => source.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

describe('context.tsx exports none of the moved pieces (QA)', () => {
  // [A1]
  it.each(MOVED_RUNTIME_NAMES)('the context module has no runtime export %s/%s', (_mod, name) => {
    expect(Object.keys(context)).not.toContain(name);
  });

  // [A2]
  it.each(MOVED_RUNTIME_NAMES)('%s still exports %s', (mod, name) => {
    expect(RUNTIME_MOVED[mod][name]).toBeDefined();
  });

  // [A3] a bare `export { Name }` / `export type { Name }` (no `from`) slips past a from-only check
  it('context.tsx has no bare export list naming a moved piece', () => {
    const lists = stripLineComments(contextSource).match(/^\s*export\s+(?:type\s+)?\{[^}]*\}/gm) ?? [];
    const named = lists.flatMap((list) =>
      list.slice(list.indexOf('{') + 1, list.indexOf('}')).split(',')
        .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim())
        .filter(Boolean),
    );
    const moved = [...MOVED_TYPE_NAMES, ...MOVED_RUNTIME_NAMES.map(([, name]) => name)];
    expect(named.filter((name) => moved.includes(name))).toEqual([]);
  });

  // [A4] a type re-declared under the old name in context.tsx would bring the pass-through back
  it.each(MOVED_TYPE_NAMES)('context.tsx does not declare an exported type %s', (name) => {
    const declares = new RegExp(`^\\s*export\\s+(?:type|interface)\\s+${name}\\b`, 'm');
    expect(stripLineComments(contextSource)).not.toMatch(declares);
  });
});
