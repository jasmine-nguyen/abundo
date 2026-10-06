// WHIT-169 (qa, adversarial gap) — budgetEditInfo income framing must be independent
// of set-vs-edit mode: an income category that ALREADY has a budget (edit mode) keeps the
// "Edit/Update budget" copy and stays an earn-target.
import { describe, it, expect } from '@jest/globals';
import { budgetEditInfo } from '../context';
import { makeState, cat, budget } from './factory';

describe('budgetEditInfo — income in EDIT mode (WHIT-169)', () => {
  it('keeps Edit/Update copy and the earn-target framing', () => {
    const s = makeState({
      categories: [cat({ id: 'salary', name: 'Salary', bucket: 'Income' })],
      budgets: [budget({ id: 'salary', budget: 3000 })],   // existing budget -> edit mode
    });
    const info = budgetEditInfo(s, 'salary');

    expect(info.existing).toBeTruthy();
    expect(info.title).toBe('Edit budget');          // edit mode NOT coupled to income framing
    expect(info.saveText).toBe('Update budget');
    expect(info.isIncome).toBe(true);
  });
});
