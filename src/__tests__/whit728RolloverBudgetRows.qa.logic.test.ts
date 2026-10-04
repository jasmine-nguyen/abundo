// WHIT-728 follow-up QA — edges of the rollover row note: the ±$0.50 threshold is strict,
// and an Income row never carries a note even with rollover and a carryover.
import { describe, it, expect } from '@jest/globals';
import { budgetRowFor } from './support/budgetsTab';
import { cat } from './factory';

describe('rollover row note edges (WHIT-728)', () => {
  // [A1] exactly at the threshold → no note; just past it → the note
  it.each([
    [-0.5, ''],
    [0.5, ''],
    [-0.51, 'Includes past overspend'],
    [0.51, 'Includes past leftovers'],
  ])('carryover %p → note %p', (carryover, expected) => {
    const row = budgetRowFor({ budget: 100, posted: 50, pending: 0, rollover: true, carryover });
    expect(row.note).toBe(expected);
  });

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
