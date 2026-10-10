// Test fixtures + a minimal state factory for the pure selectors in context.tsx.
// The selectors (budgetViews, transactionView, budgetDetail, ...) only read a
// handful of AppContext fields, so we build just those and cast — no provider,
// no React, so these run headlessly anywhere (incl. the CI merge gate).
import { ROLLUP_KEY } from '../model';
import { cycleName } from '../payCycle';
import { MILESTONES } from '../milestones';
import type { Category, Transaction } from '../types';
import type { Budget, HomeLoanState, Rule } from '../model';
import type { AiGoalSignal, BreakdownRollup, BudgetRollup, CategorySpend, LoanFacts, MilestoneRecord, Repayment } from '../api';
import { COFFEE } from './support/categories';

// A saved-plan fixture (the suggested template as MilestoneRecord rows, with ids). The default
// for milestone view-math tests that just need SOME plan — the empty-state tests pass [] instead.
// Since the hardcoded default was removed, milestoneView returns an empty view for an absent plan,
// so these factories seed this so pre-existing view-math assertions keep exercising a real plan.
export const DEFAULT_MILESTONES: MilestoneRecord[] = MILESTONES.map((m, i) => ({
  id: `m${i}`, label: m.label, targetBalance: m.targetBalance, targetDate: m.targetDate,
}));

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
  return { ...COFFEE, ...over };
}

export function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
    description: 'WOOLWORTHS', merchant_name: 'Woolworths', amount: -12.5,
    account_id: 'a1', account_name: 'Everyday', category: 'groceries',
    status: 'posted', type: 'purchase', counts_to_budget: true, ...over,
  };
}

// Charges on the ANZ account, as the bank sends them.
const anzTxn = (over: Partial<Transaction>): Transaction => txn({ account_name: 'ANZ', type: 'PAYMENT', ...over });

export function colesTxn(over: Partial<Transaction> = {}): Transaction {
  return anzTxn({ description: 'COLES', merchant_name: 'Coles', category: null, ...over });
}

export function cafeTxn(over: Partial<Transaction> = {}): Transaction {
  return anzTxn({ description: 'CAFE', merchant_name: 'Cafe', amount: -6, category: 'coffee', ...over });
}

// A pending Anthropic subscription on the Westpac account, the row the delete tests remove.
export function anthropicSubTxn(over: Partial<Transaction> = {}): Transaction {
  return txn({
    transaction_id: 'dup', date: '2026-09-27', authorized_date: '2026-09-27',
    description: 'ANTHROPIC* CLAUDE SUB', merchant_name: 'Anthropic', amount: -170.01,
    account_name: 'Westpac', category: 'subscriptions', status: 'pending', type: 'PAYMENT', ...over,
  });
}

// An old unfiled charge, found only by searching.
export function stevenTxn(over: Partial<Transaction> = {}): Transaction {
  return anzTxn({
    description: 'STEVEN NGUYEN', merchant_name: 'Steven Nguyen', amount: -50,
    date: '2020-01-01', authorized_date: '2020-01-01', category: null, ...over,
  });
}

// WHIT-539: a client Rule fixture (isNew is required on the interface). Defaults to a
// description/contains rule filing into 'coffee', the fixture transaction's category.
export function rule(over: Partial<Rule> = {}): Rule {
  return { id: 'r1', pattern: 'COLES', categoryId: 'coffee', isNew: false, field: 'description', operator: 'contains', ...over };
}

// The server's 'available to spend' (WHIT-549 unified formula), test-side only so fixtures carry
// the figure the server would send. The app reads it, never computes it (WHIT-840).
export function serverAvailable(parts: { target: number; rollover?: boolean; carryover?: number; spreadAdjustment?: number }): number {
  return parts.target + (parts.rollover ? parts.carryover ?? 0 : 0) + (parts.spreadAdjustment ?? 0);
}

export function budget(over: Partial<Budget> = {}): Budget {
  const merged = { id: 'coffee', budget: 100, posted: 40, pending: 10, rollover: false, carryover: 0, spreadAdjustment: 0, ...over };
  return { ...merged, available: over.available ?? serverAvailable({ ...merged, target: merged.budget }) };
}

// A /budgets wire row with the server's `available` filled in from its target/rollover/spread.
export function budgetRow(over: Partial<BudgetRollup> = {}): BudgetRollup {
  const row = { target: 100, posted: 0, pending: 0, ...over };
  return { ...row, available: over.available ?? serverAvailable({ ...row, spreadAdjustment: row.spread?.adjustment }) };
}

export function spend(over: Partial<CategorySpend> = {}): CategorySpend {
  return { posted: 40, pending: 10, ...over };
}

// Attach the server's __rollup__ sentinel to a breakdown map (it rides in the same object
// the server returns; the map is typed Record<string, CategorySpend>, so cast). Since WHIT-358
// the server always sends this, so a fixture exercising categoryBreakdown's parent path supplies
// the netted parent nodes here rather than relying on any on-device tally.
export function withRollup(breakdown: Record<string, CategorySpend>, rollup: BreakdownRollup): Record<string, CategorySpend> {
  (breakdown as Record<string, unknown>)[ROLLUP_KEY] = rollup;
  return breakdown;
}

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
  homeLoan?: HomeLoanState;
  loanFacts?: LoanFacts;
  repayment?: Repayment;
  milestones?: MilestoneRecord[];
  cycleLen?: number;
  daysLeft?: number;
}

// Build the exact slice the pure selectors read — a category() lookup, cycleName,
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
    homeLoan: over.homeLoan ?? { balance: null, asOf: null },
    loanFacts: over.loanFacts ?? LOAN_FACTS,
    repayment: over.repayment ?? NO_REPAYMENT,
    // A default saved plan so view-math tests get a real plan (the hardcoded default was removed);
    // pass `milestones: []` to exercise the no-plan empty state.
    milestones: over.milestones ?? DEFAULT_MILESTONES,
    cycleLen,
    daysLeft: over.daysLeft ?? 7,
    category: (id: string | null) => categories.find((c) => c.id === id),
    cycleName: cycleName(cycleLen),
  };
}
