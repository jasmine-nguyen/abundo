// WHIT-576 parity: the app's transactionMatchesSearch must agree with the server's
// transaction_matches_search (lambda_api/transaction_search.py), which searches ALL history. Both
// halves load the SAME committed truth table (tests/fixtures/transaction_search_parity.json), so a
// change to either side's matching reddens. `require` (not import) sidesteps a tsc JSON-path
// check across the src/ boundary, mirroring budgetSubtreeParity.logic.test.ts.
import { describe, it, expect } from '@jest/globals';
import { transactionMatchesSearch, SEARCH_NOTES_AND_TAGS, SEARCH_QUERY_MAX_LEN } from '../context';
import type { Category, Transaction } from '../context';

const fixture = require('../../tests/fixtures/transaction_search_parity.json') as {
  includeNotesAndTags: boolean;
  queryMaxLength: number;
  categories: { id: string; name: string }[];
  cases: { name: string; via?: string; txn: Partial<Transaction>; query: string; match: boolean }[];
};
const byId = new Map(fixture.categories.map((category) => [category.id, category as unknown as Category]));
const category = (id: string | null) => (id == null ? undefined : byId.get(id));

describe('transactionMatchesSearch — parity with the server search (WHIT-576)', () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const expected = testCase.match && (testCase.via !== 'notesTags' || fixture.includeNotesAndTags);
    expect(transactionMatchesSearch({ category }, testCase.txn as Transaction, testCase.query)).toBe(expected);
  });

  it('shares the server settings pinned in the fixture', () => {
    expect(SEARCH_NOTES_AND_TAGS).toBe(fixture.includeNotesAndTags);
    expect(SEARCH_QUERY_MAX_LEN).toBe(fixture.queryMaxLength);
  });
});
