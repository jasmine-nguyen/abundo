// WHIT-195 — selectRules maps the server enrichment payload into the client Rule shape
// (value→pattern, isNew:false for loaded rules, field/operator passed through). Pure
// exported production fn shared by the ['rules'] query and the store loader — fails on revert.
import { describe, it, expect } from '@jest/globals';
import { selectRules } from '../queries';
import type { EnrichmentRule } from '../api';

const SERVER: EnrichmentRule[] = [
  { id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' },
  { id: 'e2', field: 'category', operator: 'equals', value: 'FOOD_AND_DRINK', categoryId: 'eatingout' },
];

describe('selectRules', () => {
  it('maps value→pattern, sets isNew:false, and preserves field/operator', () => {
    expect(selectRules(SERVER)).toEqual([
      { id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false, field: 'description', operator: 'contains' },
      { id: 'e2', pattern: 'FOOD_AND_DRINK', categoryId: 'eatingout', isNew: false, field: 'category', operator: 'equals' },
    ]);
  });

  it('maps an empty payload to an empty list', () => {
    expect(selectRules([])).toEqual([]);
  });

  it('throws (fails loud) on a malformed non-array payload — not a silent empty list', () => {
    // A wrapped/changed /enrichments shape must surface as the Rules screen's error card,
    // not render "0 rules" over data the user actually has.
    expect(() => selectRules({ rules: [] } as unknown as EnrichmentRule[])).toThrow(/expected an array/);
    expect(() => selectRules(null as unknown as EnrichmentRule[])).toThrow(/expected an array/);
    expect(() => selectRules(undefined as unknown as EnrichmentRule[])).toThrow(/expected an array/);
  });
});
