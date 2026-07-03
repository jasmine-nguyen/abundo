// Test fixtures + a minimal state factory for the pure selectors in context.tsx.
// The selectors (budgetViews, transactionView, budgetDetail, ...) only read a
// handful of AppContext fields, so we build just those and cast — no provider,
// no React, so these run headlessly anywhere (incl. the CI merge gate).
import { cycleName } from '../context';
import type { AppContext, Category, Transaction, Budget, Goal } from '../context';

export function cat(over: Partial<Category> = {}): Category {
  return { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', color: '#E8A87C', bucket: 'Lifestyle', recent: 52, ...over };
}

export function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -12.5,
    account_id: 'a1', account_name: 'Everyday', category: 'groceries',
    status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
  };
}

export function budget(over: Partial<Budget> = {}): Budget {
  return { id: 'coffee', budget: 100, posted: 40, pending: 10, ...over };
}

const GOAL: Goal = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

interface StateOver {
  categories?: Category[];
  budgets?: Budget[];
  transactions?: Transaction[];
  goal?: Goal;
  cycleLen?: number;
  daysLeft?: number;
}

// Build a partial AppContext with a working category() lookup and cycleName(),
// then cast. Only the fields the selectors touch are populated.
export function makeState(over: StateOver = {}): AppContext {
  const categories = over.categories ?? [cat()];
  const cycleLen = over.cycleLen ?? 14;
  const s = {
    categories,
    budgets: over.budgets ?? [],
    transactions: over.transactions ?? [],
    goal: over.goal ?? GOAL,
    cycleLen,
    daysLeft: over.daysLeft ?? 7,
    category: (id: string | null) => categories.find((c) => c.id === id),
    cycleName: () => cycleName(cycleLen),
  };
  return s as unknown as AppContext;
}
