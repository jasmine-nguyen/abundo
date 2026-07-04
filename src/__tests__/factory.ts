// Test fixtures + a minimal state factory for the pure selectors in context.tsx.
// The selectors (budgetViews, transactionView, budgetDetail, ...) only read a
// handful of AppContext fields, so we build just those and cast — no provider,
// no React, so these run headlessly anywhere (incl. the CI merge gate).
import { cycleName } from '../context';
import type { AppContext, Category, Transaction, Budget, Goal, HomeLoanState } from '../context';
import type { CategorySpend, LoanFacts } from '../api';

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

export function spend(over: Partial<CategorySpend> = {}): CategorySpend {
  return { posted: 40, pending: 10, ...over };
}

const GOAL: Goal = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200, freedomDate: 'Aug 2045', aheadLabel: '4y 3m', interestSaved: 58200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

// A fully-set loan-facts fixture (the default). property value 770000 + LVR 0.8
// keep milestoneView's equity numbers matching the milestone-plan reference; pass
// EMPTY_LOAN_FACTS explicitly to exercise the "not set yet" empty state.
export const LOAN_FACTS: LoanFacts = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
export const EMPTY_LOAN_FACTS: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };

interface StateOver {
  categories?: Category[];
  budgets?: Budget[];
  transactions?: Transaction[];
  breakdown?: Record<string, CategorySpend>;
  goal?: Goal;
  homeLoan?: HomeLoanState;
  loanFacts?: LoanFacts;
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
    breakdown: over.breakdown ?? {},
    goal: over.goal ?? GOAL,
    homeLoan: over.homeLoan ?? { balance: null, asOf: null },
    loanFacts: over.loanFacts ?? LOAN_FACTS,
    cycleLen,
    daysLeft: over.daysLeft ?? 7,
    category: (id: string | null) => categories.find((c) => c.id === id),
    cycleName: () => cycleName(cycleLen),
  };
  return s as unknown as AppContext;
}
