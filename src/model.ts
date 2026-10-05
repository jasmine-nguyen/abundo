// WHIT-630: the client model shapes and the converters from the server payloads, moved out of
// context.tsx so queries.ts can use them without importing the store.
import type { BreakdownRollup, BudgetRollup, CarryoverCycle, CategorySpend, LoanFacts, LoanFactsInput, RuleCondition, RuleLogic, RuleRecord, SpreadPlan } from './api';
import type { Category } from './types';
import { colorForCategory } from './categoryColors';
import { normalizeColorSlot } from './chartColors';

export interface Budget {
  id: string; budget: number; posted: number; pending: number;
  // Rollover (envelope carryover). `rollover` off => `carryover` is ignored. `carryover` is
  // the signed buffer this cycle adds to the target (positive = saved up, negative = a prior
  // spike's overspend carried as a deficit). Default off/0 for a non-rollover/legacy budget.
  rollover: boolean; carryover: number;
  // The cycles behind `carryover` (newest first) and the older remainder (WHIT-742).
  carryoverCycles?: CarryoverCycle[]; carryoverEarlier?: number;
  // Bill spread (WHIT-504): `spreadAdjustment` is the signed dollars this cycle's spendable
  // moves by (a positive cushion in the anchor cycle, a negative slice in a payback cycle);
  // default 0 for a non-spread budget. `spread` carries the plan detail for the status line.
  // A category has rollover OR a spread, never both, so at most one of carryover/spreadAdjustment
  // is ever non-zero.
  spreadAdjustment: number; spread?: SpreadPlan;
  // The spendable this cycle, computed server-side on the unified Smoothing model (WHIT-549).
  // Absent on a server that predates it — the screen falls back to the old parts-sum below.
  available?: number;
}
// `pattern` mirrors the server rule's `value`; `field`/`operator` carry the
// server facts (default description/contains for app-authored rules) so a rule
// surfaced from BankSync renders truthfully. `isNew` flags the "NEW" badge and
// is client-only (server rules load as isNew:false).
export interface Rule { id: string; pattern: string; categoryId: string; isNew: boolean; field?: string; operator?: string; budgetExcluded?: boolean; spread?: boolean; spreadAmount?: number | null; spreadGapDays?: number | null; conditions?: RuleCondition[] | null; logic?: RuleLogic | null; }
// WHIT-563: the multi-condition payload a rule writer sends when the builder produced more than a
// plain "description contains" rule. Absent on the classic single-condition path (which stays a
// flat value write, preserving the WHIT-538 preview flow and pattern-based conflict detection).
export interface RuleWrite { conditions: RuleCondition[]; logic: RuleLogic; }
// The live home-loan balance from BankSync (WHIT-8). `balance` is the outstanding
// mortgage principal as a positive number, null until the balance poller's first
// run lands.
export interface HomeLoanState { balance: number | null; asOf: string | null; }

// The empty loan-facts shape shown until the user saves the form. Kept as a
// module const so every "unset" origin (initial state, a failed fetch) agrees.
// Exported (WHIT-197) so the Goal/milestone query composite has the same all-null
// default before the loan-facts read resolves.
export const EMPTY_LOAN_FACTS: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null, payoffGoalDate: null, depositTarget: null };

// Loan facts are "ready" only when the user has saved all six fields — until then
// the app shows a set-up prompt instead of any fabricated number. Narrows to
// LoanFactsInput so callers can read the fields as plain numbers.
export function loanFactsReady(f: LoanFacts): f is LoanFactsInput {
  return typeof f.original === 'number' && typeof f.homeValue === 'number' && typeof f.lvr === 'number'
    && typeof f.ratePct === 'number' && typeof f.baseRepay === 'number' && typeof f.extra === 'number';
}

/**
 * Map a raw category object from the categories API into the client-side
 * `Category` shape, defaulting any missing field so downstream budget math never
 * sees `undefined`/`NaN`. The server always returns `recent: 0`, and `icon`
 * falls back to a key that is guaranteed to exist in the icon map (`coffee`)
 * rather than the server's own default, so the chip always renders a glyph.
 *
 * @param raw - A single category record as returned by the categories API.
 * @returns A fully-populated `Category` safe to store and render.
 */
export function toCategory(raw: any): Category {
  return {
    id: raw.id,
    name: raw.name,
    bucket: raw.bucket,
    icon: raw.icon ?? 'coffee',
    color: colorForCategory(raw.id),
    recent: typeof raw.recent === 'number' ? raw.recent : 0,
    parent: raw.parent ?? null,
    // The Insights chart's permanent colour. Absent or unusable → undefined, so the chart falls
    // back to the id-derived colour. NOT `raw.colorSlot || undefined` (that drops slot 0, a real
    // slot — Eating Out) and NOT `?? 0` (that would paint every slot-less category one pink, which
    // reads as a rendering bug rather than a loud failure).
    colorSlot: normalizeColorSlot(raw.colorSlot),
  };
}

// Merge a server budget target into the client Budget shape. The server rollup owns
// the target AND the computed posted/pending spend for the window, so we take all three
// straight from it. Module-level + exported so the ['budgets'] query's selectBudgets
// reuses the exact same mapping.
export function toBudget(id: string, rollup: BudgetRollup): Budget {
  // rollover/carryover are absent on a non-rollover/legacy budget — default them so every
  // Budget has a concrete shape (no `undefined` leaking into the available/remain math).
  return {
    id, budget: rollup.target, posted: rollup.posted, pending: rollup.pending,
    rollover: rollup.rollover ?? false, carryover: rollup.carryover ?? 0,
    carryoverCycles: rollup.carryover_cycles ?? [], carryoverEarlier: rollup.carryover_earlier ?? 0,
    spreadAdjustment: rollup.spread?.adjustment ?? 0, spread: rollup.spread,
    // Pass through the server-computed spendable; stays undefined when the server omits it,
    // so the screens' `?? <parts-sum>` fallback fires (WHIT-549).
    available: rollup.available,
  };
}

// Map a server rule into the client `Rule` shape. `value` -> `pattern`
// (what the list renders); loaded rules are never "new". Module-level + exported
// (WHIT-195) so the ['rules'] query's selectRules reuses the exact same mapping.
export function toRule(raw: RuleRecord): Rule {
  return { id: raw.id, pattern: raw.value, categoryId: raw.categoryId, isNew: false, field: raw.field, operator: raw.operator, budgetExcluded: raw.budgetExcluded, spread: raw.spread, spreadAmount: raw.spreadAmount, spreadGapDays: raw.spreadGapDays, conditions: raw.conditions, logic: raw.logic };
}

// The sentinel category id the /breakdown endpoint uses for spend that counts to
// budget but has no home in the taxonomy (a raw BankSync enum, a deleted category,
// or null). Mirrors UNCATEGORIZED_KEY in lambda_api/api_constants.py.
export const UNCATEGORIZED_KEY = '__uncategorized__';

// The sentinel key the /breakdown endpoint uses for the total EARNED this cycle (all
// Income-bucket categories) — read by the Insights Earned-vs-Spent chart, never a spend
// row. Mirrors EARNED_KEY in lambda_api/api_constants.py.
export const EARNED_KEY = '__earned__';

// The sentinel key the /breakdown endpoint uses for the PER-SOURCE income breakdown (WHIT-366):
// {income_category_id: CategorySpend} for each Income-bucket category that earned this cycle.
// Rides in the same map as the per-category spend (same CategorySpend shape) but is income, not
// a spend row — read via `readIncomeSources`, and skipped in `categoryBreakdown` so it never
// counts as spend. Mirrors INCOME_KEY in lambda_api/api_constants.py.
export const INCOME_KEY = '__income__';

// The sentinel key the /breakdown endpoint uses for the server-owned parent roll-up (WHIT-349):
// netted parent totals + refund detail. It rides in the same map as the per-category spend but
// has a different shape, so it's read via `readRollup`, not the index type. Mirrors ROLLUP_KEY
// in lambda_api/api_constants.py. Defined here (not imported from ./api) so mocking ./api in a
// screen test doesn't have to stub it — same as the two sentinels above.
export const ROLLUP_KEY = '__rollup__';

/** Read the __rollup__ roll-up out of a /breakdown response. Since WHIT-358 the server always
 * emits it, so `undefined` means only a pre-WHIT-358 server or a cold `{}` cache before first fetch. */
export function readRollup(breakdown: Record<string, CategorySpend>): BreakdownRollup | undefined {
  return (breakdown as Record<string, unknown>)[ROLLUP_KEY] as BreakdownRollup | undefined;
}

/** Read the __income__ per-source income map out of a /breakdown response (WHIT-366). `undefined`
 * means no income this cycle (or a pre-WHIT-366 server) — the drill-into-Earned screen shows its
 * empty state. Shaping into a sorted, zero-dropped list lives in `useInsightsScreenData`. */
export function readIncomeSources(breakdown: Record<string, CategorySpend>): Record<string, CategorySpend> | undefined {
  return (breakdown as Record<string, unknown>)[INCOME_KEY] as Record<string, CategorySpend> | undefined;
}
