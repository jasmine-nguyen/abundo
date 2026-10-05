// WHIT-722: the shared budgetDetailFor builder serves any category, not just coffee —
// the budget's id and the lookup follow the given category's id.
import { describe, it, expect } from '@jest/globals';
import { cat } from './factory';
import { budgetDetailFor } from './support/budgetsTab';

const sink = () => cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle' });

describe('budgetDetailFor — any category', () => {
  it("builds the detail for a non-coffee category's budget", () => {
    const d = budgetDetailFor({ budget: 100, posted: 40 }, undefined, sink());
    expect(d).not.toBeNull();
    expect(d.name).toBe('Sink');
    expect(d.ofBudget).toBe('of\u00a0$100');
    expect(d.statusLabel).toBe('On track for payday');
  });

  it("folds a non-coffee budget's rollover carryover into its envelope", () => {
    const d = budgetDetailFor({ budget: 100, posted: 0, rollover: true, carryover: 30 }, undefined, sink());
    expect(d).not.toBeNull();
    expect(d.ofBudget).toBe('of\u00a0$130');
  });
});
