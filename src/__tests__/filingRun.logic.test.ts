// WHIT-629 slice 2 — the filing run's pure rules.
//
// One module decides, for all three filing sheets (the "Apply my rules" sweep, file by shop and
// new rule), which rule goes to the server and whether a run is small enough to file now or must
// go to a background job. These are the rules no sheet may compute for itself any more.
import { describe, it, expect } from '@jest/globals';
import { ruleFor, needsBackground } from '../filingRun';
import type { FilingTarget } from '../filingRun';
import type { UncategorizedMerchantGroup } from '../api';
import { applyRulesReport } from './support/applyRulesReport';

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 4,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};

const report = (matched: number) => applyRulesReport({ rulesConsidered: 1, unfiled: matched, matched });

describe('ruleFor: the rule each filing target sends', () => {
  it('sends no rule for the plain sweep', () => {
    expect(ruleFor({ kind: 'sweep' })).toBeUndefined();
  });

  it('sends the shop group pattern with the picked category', () => {
    const target: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
    expect(ruleFor(target)).toEqual({ value: 'coles', categoryId: 'groceries' });
  });

  it('sends the typed pattern trimmed, with the budget flag, for a new rule', () => {
    const target: FilingTarget = { kind: 'newRule', pattern: '  COLES ', categoryId: 'groceries', budgetExcluded: true };
    expect(ruleFor(target)).toEqual({ value: 'COLES', categoryId: 'groceries', budgetExcluded: true });
  });
});

describe('needsBackground: now or background job', () => {
  it('files 300 matched charges now and sends 301 to a background job', () => {
    expect(needsBackground(report(300))).toBe(false);
    expect(needsBackground(report(301))).toBe(true);
  });
});
