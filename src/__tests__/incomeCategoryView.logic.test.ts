// WHIT-158 (independent/adversarial half) — a USER income-bucket category (id
// 'salary') assigned to a txn must render as its OWN name/icon/colour and be
// not-tappable. It must NOT collapse into the grey BankSync 'income' PSEUDO-category
// (id === 'income'), which is a different thing (transactionView branches on the
// literal id 'income', not on the bucket).
import { describe, it, expect } from '@jest/globals';
import { transactionView } from '../context';
import { makeState, cat, txn } from './factory';

describe('transactionView — user income category is first-class (WHIT-158)', () => {
  const s = () => makeState({
    categories: [cat({ id: 'salary', name: 'Salary', icon: 'briefcase', color: '#35d9a0', bucket: 'Income' })],
  });

  it('renders its own name + icon + colour (not the grey "Income" pseudo-label)', () => {
    const v = transactionView(s(), txn({ category: 'salary', amount: 5000 }));
    expect(v.categoryLabel).toBe('Salary');   // NOT 'Income'
    expect(v.icon).toBe('briefcase');          // NOT the pseudo 'home'
    expect(v.iconColor).toBe('#35d9a0');       // NOT the grey '#9aa2b5'
  });

  it('is not tappable (it is categorized) and shows the +$ income amount', () => {
    const v = transactionView(s(), txn({ category: 'salary', amount: 5000 }));
    expect(v.tappable).toBe(false);
    expect(v.amountLabel).toBe('+$5,000.00');
    expect(v.amountColor).toBe('#35d9a0');
  });
});
