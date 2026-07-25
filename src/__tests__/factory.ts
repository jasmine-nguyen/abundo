// Test fixtures + a minimal state factory for the pure selectors in context.tsx.
// The selectors (budgetViews, transactionView, budgetDetail, ...) only read a
// handful of AppContext fields, so we build just those and cast — no provider,
// no React, so these run headlessly anywhere (incl. the CI merge gate).
import { cycleName } from '../context';
import type { Category, Transaction, Budget, Goal, HomeLoanState } from '../context';
import type { AiGoalSignal, CategorySpend, LoanFacts, Repayment } from '../api';
import type { GoalScreenData } from '../queries';

// Narrow an AiGoalSignal to the payoff arm (partial/flat/ahead), so payoff-arm tests
// can read mortgage_free_date / months_sooner_per_100_extra without a cast. Throws on
// null or the 'shortfall' arm — a shortfall reaching a payoff assertion is a real bug.
export function asPayoffGoal(g: AiGoalSignal | null): Extract<AiGoalSignal, { mortgage_free_date: string }> {
  if (!g || g.payoff_mode === 'shortfall') {
    throw new Error(`expected a payoff goal, got ${g ? g.payoff_mode : 'null'}`);
  }
  return g;
}

// Narrow to the shortfall arm (WHIT-126), so shortfall tests read goal_date /
// required_repayment / required_extra without a cast. Throws on null or a payoff arm.
export function asShortfallGoal(g: AiGoalSignal | null): Extract<AiGoalSignal, { payoff_mode: 'shortfall' }> {
  if (!g || g.payoff_mode !== 'shortfall') {
    throw new Error(`expected a shortfall goal, got ${g ? g.payoff_mode : 'null'}`);
  }
  return g;
}

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
  ratePct: 5.74, baseRepay: 1240, extra: 200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

// A fully-set loan-facts fixture (the default). property value 770000 + LVR 0.8
// keep milestoneView's equity numbers matching the milestone-plan reference; pass
// EMPTY_LOAN_FACTS explicitly to exercise the "not set yet" empty state.
export const LOAN_FACTS: LoanFacts = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };
export const EMPTY_LOAN_FACTS: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null, payoffGoalDate: null };

// Repayment fixtures (WHIT-115): a real repayment with a paired split, and the
// "none on record" empty shape (the makeState default).
export const REPAYMENT: Repayment = { amount: 1440, date: '2026-07-01', principal: 1208, interest: 232 };
export const NO_REPAYMENT: Repayment = { amount: null, date: null, principal: null, interest: null };

interface StateOver {
  categories?: Category[];
  budgets?: Budget[];
  transactions?: Transaction[];
  breakdown?: Record<string, CategorySpend>;
  goal?: Goal;
  homeLoan?: HomeLoanState;
  loanFacts?: LoanFacts;
  repayment?: Repayment;
  cycleLen?: number;
  daysLeft?: number;
}

// The Goal tab + milestone screen composite (WHIT-197). Typed off the REAL
// GoalScreenData so a screen test's mocked useGoalScreenData can't silently drift from
// the production shape (a drift fails to compile here). Defaults: fully-set loan facts,
// an un-loaded balance, no repayment, no error. Override per test via `over`.
export function makeGoalData(over: Partial<GoalScreenData> = {}): GoalScreenData {
  return {
    loanFacts: LOAN_FACTS,
    homeLoan: { balance: null, asOf: null },
    repayment: NO_REPAYMENT,
    isLoading: false,
    isError: false,
    homeLoanError: false,
    repaymentError: false,
    refetch: () => {},
    refetchStale: () => {},
    ...over,
  };
}

// Build the exact slice the pure selectors read — a category() lookup, cycleName(),
// and the data fields — and return it as its concrete inferred shape. WHIT-192: the
// selectors take NARROW inputs (BudgetViewsInput, GoalViewInput, ...) rather than the
// whole AppContext (whose server-data fields are gone with the eager store), so this
// structural fixture satisfies them field-by-field without any cast.
export function makeState(over: StateOver = {}) {
  const categories = over.categories ?? [cat()];
  const cycleLen = over.cycleLen ?? 14;
  return {
    categories,
    budgets: over.budgets ?? [],
    transactions: over.transactions ?? [],
    breakdown: over.breakdown ?? {},
    goal: over.goal ?? GOAL,
    homeLoan: over.homeLoan ?? { balance: null, asOf: null },
    loanFacts: over.loanFacts ?? LOAN_FACTS,
    repayment: over.repayment ?? NO_REPAYMENT,
    cycleLen,
    daysLeft: over.daysLeft ?? 7,
    category: (id: string | null) => categories.find((c) => c.id === id),
    cycleName: () => cycleName(cycleLen),
  };
}
