// WHIT-728 follow-up QA — an Income row never carries a rollover note, even with rollover and a carryover.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor } from './support/budgetsTab';
import { cat } from './factory';

describe('rollover row note edges (WHIT-728)', () => {
  // [A2] an Income row with rollover and a deficit carryover stays note-free
  it('an Income rollover row shows no note', () => {
    const row = budgetRowFor(
      { budget: 100, posted: 50, pending: 0, rollover: true, carryover: -300 },
      cat({ bucket: 'Income' }),
    );
    expect(row.section).toBe('earning');
    expect(row.note).toBe('');
  });
});
