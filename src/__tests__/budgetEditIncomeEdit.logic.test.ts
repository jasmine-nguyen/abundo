// WHIT-169 (qa, adversarial gap) — budgetEditInfo income framing must be independent
// of set-vs-edit mode. The implementer's income test is SET mode (budgets: []) with
// recent 4000; this pins the untested combination: an income category that ALREADY has
// a budget (edit mode) AND the prod-real recent:0. Edit copy must stay "Edit/Update
// budget" while the recommendation stays suppressed and stats dash to "—" (never "$0").
// Asserts against the real exported budgetEditInfo, so reverting the income branch fails.
import { describe, it, expect } from '@jest/globals';
import { budgetEditInfo } from '../context';
import { makeState, cat, budget } from './factory';

describe('budgetEditInfo — income in EDIT mode, prod-like recent 0 (WHIT-169)', () => {
  it('keeps Edit/Update copy but still suppresses the recommendation and dashes stats', () => {
    const s = makeState({
      categories: [cat({ id: 'salary', name: 'Salary', bucket: 'Income', recent: 0 })],
      budgets: [budget({ id: 'salary', budget: 3000 })],   // existing budget -> edit mode
    });
    const info = budgetEditInfo(s, 'salary');

    expect(info.existing).toBeTruthy();
    expect(info.title).toBe('Edit budget');          // edit mode NOT coupled to income framing
    expect(info.saveText).toBe('Update budget');
    expect(info.isIncome).toBe(true);
    expect(info.hasRecommendation).toBe(false);      // recommendation still suppressed in edit mode
    expect(info.recPrompt).toBe('Set your income floor');
    expect(info.historyToggleLabel).toBe('View earning history');
    expect(info.lastLabel).toBe('—');                // recent 0 must NOT surface as "$0"
    expect(info.avgLabel).toBe('—');
  });
});
