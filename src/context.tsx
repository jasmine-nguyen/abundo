import React, { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { C, tint, fmt, fmtExact, fmtSignedExact, ADJUSTMENT_ROW, RECONCILE_EPSILON } from './theme';
import { writeFailureMessage, ApiError } from './apiError';
import { MONTHS, formatDayMonth, formatWeekdayShort, isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from './dateutil';
import { createCategory, updateCategory, deleteCategory as apiDeleteCategory, setBudget as apiSetBudget, deleteBudget as apiDeleteBudget, setSpread as apiSetSpread, deleteSpread as apiDeleteSpread, setTransactionCategory as apiSetTransactionCategory, setTransactionCategories as apiSetTransactionCategories, setTransactionFields as apiSetTransactionFields, deleteTransaction as apiDeleteTransaction, setPayCycle as apiSetPayCycle, setLoanFacts as apiSetLoanFacts, saveGoal as apiSaveGoal, deleteGoal as apiDeleteGoal, setMilestones as apiSetMilestones, GoalRecord, GoalWriteBody, LoanFacts, LoanFactsInput, MilestoneRecord, Repayment, BudgetRollup, CategorySpend, BreakdownRollup, createRule, updateRule as apiUpdateRule, deleteRule as apiDeleteRule, RuleRecord, RuleCondition, RuleLogic, fetchAiInsights, generateAiInsights as apiGenerateAiInsights, AiInsights, AiGoalSignal, ApplyRulesJob, CreatedRule, UncategorizedMerchantGroup } from './api';
import * as Crypto from 'expo-crypto';
import { usableEquity as computeUsableEquity, milestoneTime } from './milestones';
import { reinsertBefore } from './reinsert';
import { RULE_FIELD_OPERATORS } from './ruleVocabulary';

export type { LoanFacts, LoanFactsInput } from './api';
export type { ApplyRulesResult, ApplyRulesJob } from './api';
export { unionById, budgetSubtreeContains } from './transactionCache';
export type { FilingResult, FilingTarget, FilingWhen } from './filingRun';
export { APPLY_RULES_MAX_WRITES } from './filingRun';
import type { Bucket, Category, Transaction } from './types';
import { loanFactsReady, toCategory, toRule, EMPTY_LOAN_FACTS, UNCATEGORIZED_KEY, EARNED_KEY, INCOME_KEY, ROLLUP_KEY, readRollup, type Budget, type Rule, type RuleWrite, type HomeLoanState } from './model';
import { cycleName, cycleClock, cycleClockView, elapsedFrac } from './payCycle';
import { availableToSpend, contributesToBudget, pacePct, paceTarget, paceWarning, paidInOneGo } from './budgetMath';
import { breakdownKey, budgetsKey, categoriesKey, filingSuggestionsKey, goalsKey, loanFactsKey, milestonesKey, payCycleKey, rulesKey, transactionsSearchKey } from './queryKeys';
import { queryClient } from './queryClient';
import { readTransactionCopies, findTransaction, patchTransactionsCache, patchAllCopies, removeFromAllCopies, optimisticRefile, refreshAfter } from './transactionCache';
import { runOptimisticSave, type SaveSteps } from './optimisticSave';
import { useFilingRun, type FilingResult, type FilingTarget, type FilingWhen } from './filingRun';
import { getStatus, subscribe } from './auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
// WHIT-539: the line shown when a rule auto-filed a charge but there is no readable
// merchant text to name it — a rule that matched on category type (its pattern is a raw
// enum, not human text), or a stamp whose rule was since renamed/deleted (a dangling id).
// Never echoes a raw id.
export const RULE_FILED_FALLBACK = 'Filed automatically by one of your rules';
// WHIT-539: human text for the rule that auto-filed a charge, e.g.
// `Filed by your rule: contains "COLES"`. A category/equals rule matches on the raw
// category enum, so it falls back to the generic line rather than echoing the enum.
export function ruleFiledLabel(rule: Rule): string {
  // No readable merchant text to name: a category/equals rule matches on a raw enum, and a
  // blank pattern (a malformed rule) has nothing to quote. Both fall back to the generic line.
  if (rule.field === 'category' || !rule.pattern?.trim()) return RULE_FILED_FALLBACK;
  const operator = rule.operator ?? 'contains';
  return `Filed by your rule: ${operator} "${rule.pattern}"`;
}
export type Sheet =
  // WHIT-324: the detail screen and the Transactions list share ONE categorize flow — picker →
  // confirm offering "All from this merchant" vs "Just this one". (Pre-324 a detail re-file set a
  // `refileOnly` flag to collapse the confirm to a single Save; that special case is gone.)
  | { mode: 'picker'; txId: string }
  | { mode: 'confirm'; txId: string; categoryId: string }
  // WHIT-291: multi-select re-categorise. `pickerMany`/`confirmMany` carry a captured SET of
  // transaction ids (from the Transactions selection mode) instead of one; the confirm re-files
  // them all at once via applyCategoryToMany (batch persist + partial rollback, no rule sweep).
  | { mode: 'pickerMany'; txIds: string[] }
  | { mode: 'confirmMany'; txIds: string[]; categoryId: string }
  | { mode: 'addrule'; ruleId?: string }   // ruleId set -> editing an existing rule
  | { mode: 'paycycle' }
  | { mode: 'goalbalance'; goalId: string } // update a manual goal's balance in place (WHIT-235)
  // WHIT-508: preview then apply the user's existing rules to charges already stored. No params —
  // everything it shows comes from the server's own plan summary.
  | { mode: 'applyRules' }
  // WHIT-517: "File by shop" — pick a shop from the server's grouped list, then confirm minting a
  // rule + filing that shop's charges. The confirm carries the whole group (captured at pick time)
  // plus the chosen category, so the "shown what will happen" step needs no refetch.
  | { mode: 'fileByShopList' }
  | { mode: 'fileByShopConfirm'; group: UncategorizedMerchantGroup; categoryId: string }
  // WHIT-538: after the user types a new rule, this confirm step previews how many stored charges
  // the rule would file (with samples) before Save, then either mints + files them in one call or
  // saves the rule for future charges only. Carries the typed pattern + chosen category captured
  // from the add-rule form. Reuses the FileByShopConfirm flow (dry-run preview, then commit).
  | { mode: 'addRuleConfirm'; pattern: string; categoryId: string; budgetExcluded: boolean }
  | null;

export const BUCKETS: Bucket[] = ['Living', 'Lifestyle', 'Income', 'Savings'];

// Max charges per batch category write. Mirrors the server's TRANSACTION_BATCH_MAX
// (lambda_api/api_constants.py) — the "All from this merchant" sweep splits into chunks
// of this size so a large merchant spans multiple requests instead of tripping the
// server's per-request cap. Keep the two equal.
const CATEGORY_BATCH_LIMIT = 100;

// WHIT-292: the batch category write shared by applyCategory('all') and applyCategoryToMany.
// Chunk the ids under the server's per-request cap (CATEGORY_BATCH_LIMIT), send the chunks
// together, then reconcile BY ID — never array position, so server order is never trusted.
// An id counts as saved only if some chunk returned it with status 'updated'; a rejected chunk
// (or a malformed/missing `results`, guarded by `?? []`) leaves its ids in failedIds. Empty ids
// yield no chunks -> no API call (the server would 400 an empty body). Each caller keeps its OWN
// optimistic write, rollback strategy, and toasts — only this common middle lives here.
export async function persistCategoryBatch(
  ids: string[],
  categoryId: string,
): Promise<{ savedIds: Set<string>; failedIds: string[] }> {
  const updates = ids.map((id) => ({ id, category: categoryId }));
  const chunks: { id: string; category: string }[][] = [];
  for (let i = 0; i < updates.length; i += CATEGORY_BATCH_LIMIT) {
    chunks.push(updates.slice(i, i + CATEGORY_BATCH_LIMIT));
  }
  const outcomes = await Promise.allSettled(chunks.map((chunk) => apiSetTransactionCategories(chunk)));
  const savedIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue;
    for (const r of outcome.value?.results ?? []) {
      if (r.status === 'updated') savedIds.add(r.id);
    }
  }
  const failedIds = ids.filter((id) => !savedIds.has(id));
  return { savedIds, failedIds };
}

export const CLEAN_NAME: Record<string, string> = {
  'DD *DOORDASH HUTIEUGOO': 'DoorDash',
  'UNIFLEX REMEDIAL MASSAGE': 'Uniflex Massage',
  // Westpac sends the same clinic unspaced; ANZ spaces it. Both map to one name.
  'UNIFLEXREMEDIALMASSAGE': 'Uniflex Massage',
  'SQ *KKV INTERNATIONAL': 'KKV International',
};
export function cleanName(m: string) { return CLEAN_NAME[m] || m; }

// Best-effort display name for a transaction's merchant, applying the cleanup
// map. Single source of truth so the transaction row and the categorize sheets
// never diverge (the Transaction shape has merchant_name/description, not payee).
export function merchantLabel(t: Transaction): string {
  return cleanName(t.merchant_name || t.description || '');
}

// The merchant slice of a description: where the merchant name appears inside the
// description, that slice using the description's OWN casing — dropping the volatile
// store#/location/ref suffix so a rule built from it generalises to future charges,
// while the preserved casing keeps the match working whether or not BankSync's
// `contains` is case-sensitive. Returns null when there's no clean merchant substring
// (no merchant name, or it isn't found in the description); a caller uses that null to
// tell a genuine merchant slice from a full-description fallback (WHIT-491) — a rule
// minted from the noisy fallback would carry volatile ref/store tokens and match nothing.
export function merchantSlice(t: Transaction): string | null {
  const desc = t.description ?? '';
  const merchant = (t.merchant_name ?? '').trim();
  if (merchant) {
    const i = desc.toLowerCase().indexOf(merchant.toLowerCase());
    if (i >= 0) return desc.slice(i, i + merchant.length);
  }
  return null;
}

// The `contains` pattern the "Every {merchant} charge" rule matches on: the merchant
// slice when there is one, else the full description (behaves as before — a rule that
// only catches this exact description).
export function rulePattern(t: Transaction): string {
  return merchantSlice(t) ?? (t.description ?? '');
}

// Lowercase + strip every non-alphanumeric char, so BankSync's descriptor variants
// for one merchant collapse to a comparable stem: `KKV INTERNATIONAL PTY Sunshine`
// and `KKV INTERNATIONAL PTYSunshine` both start `kkvinternationalpty…`. Removing
// spaces (not just punctuation) is deliberate — the variants differ by a space
// (`PTY Sunshine` vs `PTYSunshine`), which a space-preserving normaliser would keep
// apart.
function normaliseMatch(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Levenshtein edit distance (classic two-row DP). Small, dependency-free helper used
// only to score how alike two merchant names are.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr.push(Math.min(prev[j + 1] + 1, curr[j] + 1, prev[j] + cost));
    }
    prev = curr;
  }
  return prev[b.length];
}

// Fuzzy similarity of two normalised merchant names in [0,1]: 1 = identical, 0 =
// nothing shared. `1 - editDistance/maxLen`, so a short trailing descriptor on a long
// shared stem (KKV's `Sunshine`, 8 chars on a 19-char stem) scores ~0.70, while a
// short name that merely LOOKS like a prefix of a different one scores ≤0.5
// (`bp`/`bpay` ≈ 0.50, `sun`/`suncorp` ≈ 0.43, `metro`/`metropolis` = 0.50). The
// threshold below is the single knob trading variant-spanning against merging two
// genuinely different merchants.
function merchantSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

const MERCHANT_MATCH_THRESHOLD = 0.6;

// Whether transaction `t` should be swept into an "All from this merchant" batch for
// a rule whose match value is `pattern`, relative to the tapped `origin` charge.
// Requires the rule's `description contains pattern` match (normalised) AND — when
// BOTH charges carry a merchant name — that the two names are fuzzy-similar enough
// (≥ MERCHANT_MATCH_THRESHOLD) to be the same merchant. That score is what tolerates
// BankSync's descriptor variants (`KKV INTERNATIONAL PTY` vs `…PTYSunshine` ≈ 0.70)
// while rejecting look-alikes that only share a short prefix (`BP` vs `BPAY` ≈ 0.50,
// `Sun` vs `Suncorp` ≈ 0.43). When either charge lacks a merchant name the merchant
// identity is unknown, so we fall back to a SPACE-PRESERVING description contains —
// stricter than the normalised gate, so a punctuation-stripped adjacency can't sweep
// in a different merchant (`NICOLE'S CAFE` must not match `COLES`). An empty/all-
// punctuation pattern falls back to exact description equality.
export function matchesRulePattern(t: Transaction, pattern: string, origin: Transaction): boolean {
  const nPattern = normaliseMatch(pattern);
  if (!nPattern) return t.description === origin.description;
  const originMerchant = normaliseMatch(origin.merchant_name ?? '');
  const candMerchant = normaliseMatch(t.merchant_name ?? '');
  if (originMerchant && candMerchant) {
    if (!normaliseMatch(t.description).includes(nPattern)) return false;
    return merchantSimilarity(originMerchant, candMerchant) >= MERCHANT_MATCH_THRESHOLD;
  }
  // Merchant identity unknown → require the pattern to appear in the raw (space-
  // preserving) description, so a stripped adjacency can't over-match.
  return t.description.toLowerCase().includes(pattern.toLowerCase());
}

// Two rule patterns are the "same rule" when they'd match the same charges. A rule matches a
// raw `description contains value` (BankSync stores `value` verbatim), so identity PRESERVES
// spaces — unlike normaliseMatch, which strips them for transaction sweep-variant collapse.
// We fold only case + surrounding/internal whitespace, so `NETFLIX` == ` netflix ` and
// `KKV  INTL` == `KKV INTL`, but `WELLBEING SERVICES` != `WELLBEINGSERVICES` (they catch
// different descriptions, so they are NOT the same rule). Collapsing internal runs treats an
// accidental double-space as the same rule — a deliberate convenience; the raw matcher wouldn't,
// so at worst this over-merges a rare double-spaced variant, never a genuinely different merchant.
function normaliseRuleIdentity(pattern: string): string {
  return (pattern ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A new/edited rule that clashes with one the user already has. `duplicate`/`conflict` are the
// classic single-pattern cases (ruleConflict); `overlap` is the multi-condition case (ruleOverlap) —
// two DIFFERENT rules that can match one charge and disagree on category (WHIT-562).
export type RuleConflict = { kind: 'duplicate' | 'conflict' | 'overlap'; existing: Rule };

// The first existing rule whose pattern is identity-equal to `pattern`, or null if none.
// `duplicate` = same category (a no-op re-add); `conflict` = a different category (the two
// would fight, order-deciding which wins). `editingId` excludes the rule being edited so a
// rule never conflicts with itself. Pure + exported so the add-rule sheet and tests share it.
// Deliberately exact (identity) not fuzzy: a false positive would BLOCK a legitimate new rule,
// so near-duplicates (e.g. `KKV` vs `KKV INTERNATIONAL`) are left uncaught by design.
export function ruleConflict(
  rules: Rule[], pattern: string, categoryId: string, editingId?: string,
): RuleConflict | null {
  const target = normaliseRuleIdentity(pattern);
  if (!target) return null;
  for (const rule of rules) {
    if (rule.id === editingId) continue;
    if (normaliseRuleIdentity(rule.pattern) !== target) continue;
    return { kind: rule.categoryId === categoryId ? 'duplicate' : 'conflict', existing: rule };
  }
  return null;
}

// WHIT-562: the pre-save "would these two rules fight?" guard for MULTI-CONDITION rules. A multi
// rule has no single pattern, so ruleConflict's identity match can't see it — two different-but-
// overlapping rules (e.g. `COLES AND under $40 → dining` vs `COLES → groceries`) both save, then
// every charge they both match is left conflicted/unfiled by the server's `decide` (WHIT-355). The
// builder shows this as a soft warning before saving — it does NOT block.
//
// CONSERVATIVE by design (WHIT-562 decision): it flags a clash only when it can PROVE the two rules
// can co-match one charge, so it never false-blocks a legitimate rule. Text is compared by
// CONTAINMENT — one value must be a substring of the other — NOT abstract joint-satisfiability, so
// `COLES` vs `WOOLIES` is NOT flagged (they'd co-match only a contrived "COLES WOOLIES" string).
// Whatever it misses stays safe: the server never files a conflicted charge, so correctness holds
// without this guard — it is purely a heads-up.

// Trim + lowercase, mirroring the engine's `_normalise` (shared/rule_engine.py) — the normalisation
// the literal matcher applies. Deliberately does NOT collapse internal whitespace (unlike
// normaliseRuleIdentity), so we never claim an overlap the real matcher wouldn't produce.
function foldRuleMatch(value: string): string {
  return (value ?? '').trim().toLowerCase();
}

// A rule's match region as a disjunction of conjunctive clauses: "all" (AND) → one clause holding
// every condition; "any" (OR) → one single-condition clause each. Two rules can co-match iff some
// clause of one is jointly satisfiable with some clause of the other.
function ruleClauses(conditions: RuleCondition[], logic: RuleLogic): RuleCondition[][] {
  return logic === 'any' ? conditions.map((condition) => [condition]) : [conditions];
}

// A Rule read as (conditions, logic): a multi rule carries them; a classic/single rule reads as one
// condition from its flat field/operator/pattern (mirrors the engine's `_conditions_of`).
function ruleClausesOf(rule: Rule): RuleCondition[][] {
  if (rule.conditions && rule.conditions.length > 0) {
    return ruleClauses(rule.conditions, rule.logic ?? 'all');
  }
  return [[{ field: rule.field ?? 'description', operator: rule.operator ?? 'contains', value: rule.pattern }]];
}

// Can a single charge's description satisfy every text (description/merchant) condition at once?
// PROVABLE only by containment: with one `equals` value the charge string IS that value (it must
// contain every `contains` substring); with only `contains` values one of them must be a superstring
// of all the others. Non-nested values (`COLES` vs `WOOLIES`) are treated as NOT co-satisfiable.
function textConditionsSatisfiable(conditions: RuleCondition[]): boolean {
  const equals = [...new Set(conditions.filter((c) => c.operator === 'equals').map((c) => foldRuleMatch(c.value)))];
  const contains = conditions.filter((c) => c.operator === 'contains').map((c) => foldRuleMatch(c.value));
  if (equals.length >= 2) return false;
  if (equals.length === 1) return contains.every((substring) => equals[0].includes(substring));
  return contains.some((candidate) => contains.every((substring) => candidate.includes(substring)));
}

// Do the amount conditions' magnitude intervals (abs dollars, mirroring `_amount_matches`) intersect?
function amountConditionsSatisfiable(conditions: RuleCondition[]): boolean {
  let low = 0, lowInclusive = true;          // magnitude is >= 0
  let high = Infinity, highInclusive = true;
  for (const condition of conditions) {
    const raw = (condition.value ?? '').trim();
    // A blank or non-numeric value never matches (the engine's Decimal("") fails closed), so it
    // can't co-match — treat the clause as unsatisfiable. Number("") is 0, so guard the blank first.
    if (raw === '') return false;
    const threshold = Number(raw);
    if (!Number.isFinite(threshold)) return false;
    if (condition.operator === 'less_than') {
      if (threshold < high || (threshold === high && highInclusive)) { high = threshold; highInclusive = false; }
    } else if (condition.operator === 'less_than_or_equal') {
      if (threshold < high) { high = threshold; highInclusive = true; }
    } else if (condition.operator === 'greater_than') {
      if (threshold > low || (threshold === low && lowInclusive)) { low = threshold; lowInclusive = false; }
    } else if (condition.operator === 'greater_than_or_equal') {
      if (threshold > low) { low = threshold; lowInclusive = true; }
    } else {
      return false; // unknown amount operator never matches
    }
  }
  if (low < high) return true;
  return low === high && lowInclusive && highInclusive;
}

// account/category/direction are equality matches: every condition must pin the SAME value, and a
// value that never matches (empty, or a non-debit/credit direction) makes the clause unsatisfiable.
function equalityConditionsSatisfiable(conditions: RuleCondition[], normalise: (value: string) => string,
                                       isMatchable: (value: string) => boolean): boolean {
  const values = conditions.map((c) => normalise(c.value));
  if (values.some((value) => !isMatchable(value))) return false;
  return new Set(values).size <= 1;
}

// Is there a single charge that satisfies EVERY condition in this AND-clause? Conditions on different
// charge fields are independent, so the clause is satisfiable iff each field's conditions are — text
// (description/merchant share the charge description), amount, direction, account, category.
function clauseSatisfiable(conditions: RuleCondition[]): boolean {
  // A (field, operator) the engine can't evaluate never matches (mirrors _condition_matches
  // returning False), so it makes this AND-clause unsatisfiable — a rule can't co-match on it.
  if (conditions.some((condition) => !RULE_FIELD_OPERATORS[condition.field]?.includes(condition.operator))) return false;
  const text: RuleCondition[] = [], amount: RuleCondition[] = [], direction: RuleCondition[] = [];
  const account: RuleCondition[] = [], category: RuleCondition[] = [];
  for (const condition of conditions) {
    if (condition.field === 'description' || condition.field === 'merchant') text.push(condition);
    else if (condition.field === 'amount') amount.push(condition);
    else if (condition.field === 'direction') direction.push(condition);
    else if (condition.field === 'account') account.push(condition);
    else if (condition.field === 'category') category.push(condition);
    else return false; // an unknown field never matches
  }
  if (text.length && !textConditionsSatisfiable(text)) return false;
  if (amount.length && !amountConditionsSatisfiable(amount)) return false;
  if (direction.length && !equalityConditionsSatisfiable(direction, foldRuleMatch, (v) => v === 'debit' || v === 'credit')) return false;
  if (account.length && !equalityConditionsSatisfiable(account, (v) => (v ?? '').trim(), (v) => v.length > 0)) return false;
  if (category.length && !equalityConditionsSatisfiable(category, foldRuleMatch, (v) => v.length > 0)) return false;
  return true;
}

// The first existing rule that can co-match a charge with the candidate rule AND files it to a
// DIFFERENT category (so the two would fight), or null. `editingId` excludes the rule being edited.
// Pure + exported so the builder and its tests share it. Returns { kind: 'overlap' } so it slots
// into the same pending-warning state as ruleConflict.
export function ruleOverlap(
  rules: Rule[], conditions: RuleCondition[], logic: RuleLogic, categoryId: string, editingId?: string,
): RuleConflict | null {
  const candidateClauses = ruleClauses(conditions, logic);
  for (const rule of rules) {
    if (rule.id === editingId) continue;
    if (rule.categoryId === categoryId) continue; // agrees on category → no fight
    const existingClauses = ruleClausesOf(rule);
    const canCoincide = candidateClauses.some(
      (candidateClause) => existingClauses.some(
        (existingClause) => clauseSatisfiable([...candidateClause, ...existingClause])));
    if (canCoincide) return { kind: 'overlap', existing: rule };
  }
  return null;
}


// A home loan is repaid on its own MONTHLY schedule — a fixed direct debit —
// independent of how often the user is paid. So the payoff projection (WHIT-114)
// is always 12 periods/year; the loan-facts repayment fields are per month.
const MONTHS_PER_YEAR = 12;

// The most we'll present as a required shortfall repayment (WHIT-126). MIRRORS the
// server's _sanitise_goal cap (`_finite_number(..., high=1_000_000)` in
// lambda_api/handler.py): above it the server drops the shortfall goal, so the AI
// can't discuss it — showing a figure the AI silently ignores would be a dead-end.
// A required repayment over this cap means the goal date is unrealistically close
// for the balance, so we fall back to the plain "won't pay off" copy instead.
const MAX_SHORTFALL_REPAYMENT = 1_000_000;

// WHIT-215: a required shortfall repayment more than this multiple of the user's CURRENT
// repayment (base + extra) means the chosen goal date is implausibly soon even below the
// $1M cap — so the screen shows a gentle "try a later date" hint alongside the (honest)
// figure. A multiple, not an absolute, so it scales with the user's own repayment: a
// $85k/month "need" against a $4k repayment is obviously unreachable.
const AGGRESSIVE_REPAY_MULTIPLE = 10;

// A loan-amortization result: the (fractional) number of equal repayments to
// clear the balance, and the total interest paid over that schedule.
export interface Amort { periods: number; totalInterest: number; }

// Months to pay off `balance` paying `pmt` each month at monthly rate `i` (a
// fraction, e.g. 0.0574/12 for a 5.74% loan), plus the total interest over that
// schedule. Closed form n = -ln(1 − B·i/pmt)/ln(1+i), which rearranges the
// standard annuity formula. Returns null when the loan never pays off — the
// payment must be positive and, once interest accrues (i>0), strictly exceed the
// monthly interest B·i, or the balance can't fall. A non-positive balance is
// "already there" in 0 periods; i≤0 is the interest-free straight-line case.
export function amortize(balance: number, i: number, pmt: number): Amort | null {
  if (!(pmt > 0)) return null;
  if (balance <= 0) return { periods: 0, totalInterest: 0 };
  if (i <= 0) return { periods: balance / pmt, totalInterest: 0 };
  if (pmt <= balance * i) return null;                       // never pays off
  const periods = -Math.log(1 - (balance * i) / pmt) / Math.log(1 + i);
  return { periods, totalInterest: pmt * periods - balance };
}

// The monthly repayment needed to clear `balance` in exactly `periods` months at
// monthly rate `i` — the algebraic inverse of amortize (WHIT-126). Rearranging the
// same annuity identity B = pmt·(1 − (1+i)^(−n))/i gives pmt = B·i/(1 − (1+i)^(−n)).
// The i≤0 straight-line case is pmt = B/n (the general form is 0/0 there). Returns
// null when the inputs can't define a payment (non-positive balance or periods, or
// non-finite). For any finite periods>0 the result strictly exceeds the interest-only
// floor B·i, so amortize(balance, i, requiredRepayment(...)) always converges back.
export function requiredRepayment(balance: number, i: number, periods: number): number | null {
  if (!(balance > 0) || !(periods > 0) || !Number.isFinite(i)) return null;
  if (i <= 0) return balance / periods;
  return (balance * i) / (1 - Math.pow(1 + i, -periods));
}

// `from` advanced by `months` whole calendar months. The day is pinned to the 1st
// first — only the month-year is rendered, and otherwise a 31st + n months would
// roll "Feb 31" into March (off by a month).
function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return d;
}

// A month-year label ("Aug 2045") for the payoff projection — matches the
// granularity the hero shows (nobody expects day-precision 20 years out).
function monthYear(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// Whole calendar months from `from` to an ISO "YYYY-MM-DD" target, at month
// granularity to match monthYear (WHIT-126). Returns null on an unparseable date,
// and can be ≤ 0 for a past/current month — callers treat that as "no valid goal".
function monthsUntil(from: Date, isoDate: string): number | null {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [year, month] = parts;
  return (year - from.getFullYear()) * MONTHS_PER_YEAR + (month - (from.getMonth() + 1));
}

function dateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const date = new Date(y, m - 1, d);
  const diffDays = Math.round((today.getTime() - date.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${DAY[date.getDay()]} ${d} ${MONTHS[m - 1]}`;
}

// Group transactions under date headings ("Today", "Tue 21 Jul"), preserving the input
// order (the budget-detail list arrives newest-first). Used by the detail screen to render
// a paged slice of the related-transactions list.
export function groupTransactionsByDate(items: Transaction[]): { label: string; items: Transaction[] }[] {
  const seen = new Map<string, Transaction[]>();
  const order: string[] = [];
  for (const transaction of items) {
    const label = dateLabel(transaction.date);
    if (!seen.has(label)) { seen.set(label, []); order.push(label); }
    seen.get(label)!.push(transaction);
  }
  return order.map((label) => ({ label, items: seen.get(label)! }));
}

// ---------------------------------------------------------------------------
// AppContext
// ---------------------------------------------------------------------------
// WHIT-192: the eager server-data store is gone — every screen reads the TanStack
// Query layer (src/queries) directly. AppContext now carries only what the query
// layer can't: the alerts toggle, ephemeral UI (sheet/toast), the
// write actions (which source their reads from the query cache), and the AI-insights
// slice (still store-held pending its own migration).
export interface AppContext {
  // client-only UI state (not a server read)
  alerts: boolean;
  // ephemeral ui
  sheet: Sheet; toast: string | null;
  // WHIT-544: a one-shot intent set by the "File by shop" leftover sheet so the Transactions
  // screen can jump the user into the Uncategorized tab's multi-select. Consumed-and-cleared
  // by that screen; the sheet can't reach its local selection state directly.
  pendingUncategorizedSelect: boolean;
  // actions
  setSheet: (s: Sheet) => void;
  // WHIT-544: arm / disarm the multi-select jump above.
  requestUncategorizedSelect: () => void;
  clearUncategorizedSelect: () => void;
  // WHIT-277: read/write a pop-up sheet's draft so it survives a Face ID lock (cleared on close + sign-out).
  readSheetDraft: (key: string) => unknown;
  writeSheetDraft: (key: string, value: unknown) => void;
  // WHIT-282: the current session stamp; a screen captures it at save start and compares across an
  // await, so it bails on any session change (sign-out OR a different-account re-auth), not just anon.
  getSessionEpoch: () => number;
  showToast: (m: string) => void;
  toggleAlerts: () => void;
  setPayCycleLength: (len: number) => void;
  setPayday: (last_pay_date: string) => void;
  openPicker: (txId: string) => void;
  // WHIT-291: open the category picker for a captured SET of transactions (multi-select).
  openMultiPicker: (txIds: string[]) => void;
  openGoalBalance: (goalId: string) => void;
  chooseCategory: (categoryId: string) => void;
  applyCategory: (scope: 'one' | 'all') => Promise<void>;
  // WHIT-291: re-file every id under one category in a single batch (partial rollback on failure).
  applyCategoryToMany: (txIds: string[], categoryId: string) => Promise<void>;
  // WHIT-629: the one filing run behind the three filing sheets (see filingRun.ts). A sheet says what
  // to file; the run picks "file now" or "background job" and answers with one FilingResult.
  // `applyRulesJob` is the live job status the sheets render (null when idle).
  previewFiling: (target: FilingTarget) => Promise<FilingResult>;
  fileCharges: (target: FilingTarget, when: FilingWhen) => Promise<FilingResult>;
  retryApplyRulesJob: () => Promise<FilingResult>;
  applyRulesJob: ApplyRulesJob | null;
  applyRulesStalled: boolean;
  applyTransactionEdit: (txId: string, patch: { notes?: string; tags?: string[]; budget_excluded?: boolean }) => Promise<void>;
  // WHIT-654: true once the server deleted it; false (rolled back + toast) otherwise.
  deleteTransaction: (txId: string) => Promise<boolean>;
  saveBudget: (categoryId: string, value: number, rollover?: boolean) => Promise<boolean>;
  deleteBudget: (categoryId: string) => Promise<boolean>;
  saveSpread: (categoryId: string, amount: number, cycles: number) => Promise<boolean>;
  removeSpread: (categoryId: string) => Promise<boolean>;
  saveCategory: (editId: string | null, form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }) => Promise<boolean>;
  createCategoryInline: (form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }) => Promise<Category | null>;
  deleteCategory: (id: string) => Promise<boolean>;
  deleteRule: (id: string) => Promise<void>;
  saveManualRule: (pattern: string, categoryId: string, budgetExcluded?: boolean, write?: RuleWrite, spread?: boolean) => Promise<void>;
  updateRule: (id: string, pattern: string, categoryId: string, budgetExcluded?: boolean, write?: RuleWrite, spread?: boolean) => Promise<void>;
  saveGoal: (editId: string | null, body: GoalWriteBody) => Promise<boolean>;
  deleteGoal: (id: string) => Promise<boolean>;
  saveLoanFacts: (next: LoanFactsInput) => Promise<boolean>;
  saveMilestones: (next: MilestoneRecord[]) => Promise<boolean>;

	// AI spending insights (WHIT-104) — the last slice still held on the store; its
	// migration to a query + mutation is tracked separately.
	aiInsights: AiInsights | null;
	aiInsightsLoading: boolean;
	aiInsightsError: boolean;
	refreshAiInsights: () => Promise<void>;
	generateAiInsights: (goal?: AiGoalSignal | null) => Promise<void>;
}

// Bill-spread cycle bounds the app offers, mirroring the server (SPREAD_MIN/MAX_CYCLES,
// lambda_api/api_constants.py). Advisory only — the server re-validates and 400s a bad value —
// so a bound change server-side just needs these kept in step; the stepper clamps to them.
export const SPREAD_MIN_CYCLES = 1;
export const SPREAD_MAX_CYCLES = 24;

// Preview the per-cycle effect of spreading `amount` over `cycles`, matching the server's
// whole-cent split (shared/spend.py spread_adjustment): the cushion is the whole amount,
// slices are amount/cycles in whole cents with the first `extra` cents' slices one cent
// bigger, so the slices sum back to exactly `amount`. Drives the new screen's live preview.
export function spreadPreview(amount: number, cycles: number): { cushion: number; firstSlice: number; lastSlice: number } {
  const cents = Math.round(amount * 100);
  const base = Math.floor(cents / cycles);
  const extra = cents - base * cycles;
  // `extra` (< cycles) slices carry one cent more, so the earliest slice is base+1 cents and
  // the last is always the base — the slices sum back to `amount` exactly, as the server splits.
  const firstSlice = (base + (extra > 0 ? 1 : 0)) / 100;
  const lastSlice = base / 100;
  return { cushion: amount, firstSlice, lastSlice };
}

// WHIT-559: a spread rule save can be refused for a spread-specific reason the user can act on —
// 422 (no recurring bill matches the rule yet) or 409 (the category already has a spread rule).
// Only a write that ACTUALLY requested spread gets this copy: 409/422 mean spread on the rules
// endpoint today, but gating on `spread` keeps a future non-spread 409/422 from showing spread words.
function ruleWriteErrorMessage(error: unknown, fallback: string, spread: boolean): string {
  if (spread && error instanceof ApiError && error.status === 422) return "We couldn't find a recurring bill matching this rule";
  if (spread && error instanceof ApiError && error.status === 409) return 'This category already has a spread rule';
  return fallback;
}

const Ctx = createContext<AppContext | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [alerts, setAlerts] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<string | null>(null);
  // WHIT-544: one-shot flag bridging the "File by shop" sheet → the Uncategorized tab's
  // multi-select (the sheet can't touch that screen's local selection state).
  const [pendingUncategorizedSelect, setPendingUncategorizedSelect] = useState(false);
  // WHIT-277: a half-typed pop-up sheet's draft must survive a Face ID lock. The sheet UNMOUNTS
  // while locked — Overlays' WHIT-268 privacy shield returns null (a native Modal would otherwise
  // float above the lock cover) — so its local useState is destroyed. Stash the draft here in the
  // always-mounted provider (above the gate), so it outlives the lock. A REF, not state: a
  // keystroke writes it with zero re-renders, and the sheet reads it once on remount (post-unlock).
  // Cleared when any sheet closes (submit/cancel) and on sign-out, so nothing leaks to the next session.
  const sheetDrafts = useRef<Map<string, unknown>>(new Map());
  const readSheetDraft = useCallback((key: string): unknown => sheetDrafts.current.get(key), []);
  const writeSheetDraft = useCallback((key: string, value: unknown) => { sheetDrafts.current.set(key, value); }, []);
  // WHIT-192: rule edits are mirrored straight into the ['rules'] query cache the Rules
  // screen + Settings count read (the old eager store is gone). Applies the functional
  // updater to the cache — including the client-only isNew "NEW" badge, which a refetch
  // would reset to false. Guards an evicted/absent cache (gcTime is finite): when the
  // Rules screen was never opened there's nothing to patch, and opening it fetches fresh.
  const patchRules = useCallback((fn: (prev: Rule[]) => Rule[]) => {
    queryClient.setQueryData<Rule[]>(rulesKey, (prev) => (prev ? fn(prev) : prev));
  }, []);

	// WHIT-268: bumped once per sign-out (the anon subscription below). An async AI
	// request captures the epoch before its await and bails if it changed by the time
	// it settles — so a response that lands after sign-out is dropped even if a NEW
	// session is already live, WITHOUT dropping a response that merely lands during a
	// Face ID 'locked' window (same session, epoch unchanged — the Overlays gate hides
	// it, unlock shows it). A plain status !== 'authed' check would wrongly discard that
	// locked-window response.
	const sessionEpoch = useRef(0);
	// WHIT-282: read the current session stamp so a screen can capture-and-compare it across an await,
	// mirroring the writers' epoch guard (and getStatus()'s call idiom). Lets category/edit bail on ANY
	// session change mid-save — sign-out OR a different-account re-auth — not just a still-anon status.
	const getSessionEpoch = useCallback(() => sessionEpoch.current, []);
	// WHIT-628: every optimistic save goes through this — it owns the session check, so a save that
	// settles after sign-out neither re-plants old data nor toasts into the next session.
	const runSave = useCallback(<R, T>(steps: SaveSteps<R, T>): Promise<T> => {
		const epoch = sessionEpoch.current;
		return runOptimisticSave(() => epoch === sessionEpoch.current, steps);
	}, []);

	// WHIT-629: the filing run (preview, file now or in the background, the job view) lives in
	// filingRun.ts. A new rule's minted rule shows straight away with its NEW badge.
	const prependMintedRule = useCallback((rule: CreatedRule) => {
		patchRules((prev) => [{ ...toRule(rule as RuleRecord), isNew: true }, ...prev]);
	}, [patchRules]);
	const { previewFiling, fileCharges, retryApplyRulesJob, applyRulesJob, applyRulesStalled, endOnLock } =
		useFilingRun({ sessionEpoch, runSave, prependMintedRule, sheetOpen: sheet !== null });

	// AI spending insights (WHIT-104). `refreshAiInsights` reads the per-cycle cache
	// (free); `generateAiInsights` is the paid "Analyse my spending" action. Error is
	// true only when the last GENERATE failed, so the button can show a retry; a
	// null-summary cache (nothing generated yet) is NOT an error.
	const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
	const [aiInsightsLoading, setAiInsightsLoading] = useState(false);
	const [aiInsightsError, setAiInsightsError] = useState(false);
	const refreshAiInsights = useCallback(() => runSave({
		send: fetchAiInsights,
		onSaved: setAiInsights,
		// A failed cache read leaves the current state intact (no error surfaced);
		// the user can still generate.
		onFailed: () => {},
		whenSignedOut: undefined,
	}), [runSave]);
	// `goal` is passed IN by the caller (computed from live state at tap time), not
	// read from a closure here — so this stays a stable useCallback([]) and can never
	// send a stale goal.
	const generateAiInsights = useCallback((goal?: AiGoalSignal | null) => {
		setAiInsightsLoading(true);
		setAiInsightsError(false);
		// Only the run that still owns the session may clear the spinner: the runner skips both
		// callbacks after sign-out, so a stale run (signed out, then a NEW session started its own
		// generate) can't flip the live run's spinner off and let the new user double-fire.
		return runSave({
			send: () => apiGenerateAiInsights(goal),
			onSaved: (result) => {
				setAiInsights(result);
				setAiInsightsLoading(false);
			},
			onFailed: () => {
				setAiInsightsError(true);
				setAiInsightsLoading(false);
			},
			whenSignedOut: undefined,
		});
	}, [runSave]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear the toast timer on unmount so it can't fire a setState after teardown (a leak
  // that also kept the jest worker alive between tests).
  useEffect(() => () => {
    clearTimeout(toastTimer.current);
  }, []);

  // WHIT-268: overlays render OUTSIDE the auth gate in app/_layout.tsx, so the gate's
  // privacy cover can never hide them — the session's end must clear them here. Fires
  // on ANY broadcast into 'anon' (sign-out, a failed refresh, invalidated biometrics),
  // whichever path broadcast it. Also drops the server-derived AI insights (and its
  // stale error/loading flags), which queryClient.clear() never touches, and bumps the
  // session epoch so any in-flight AI request settling later is discarded.
  // WHIT-277: clear stashed drafts whenever the sheet closes — submit AND cancel both route
  // through setSheet(null). Only one sheet is open at a time, so clearing all is correct, and a
  // picker→confirm transition (chooseCategory) never passes through null, so it isn't cleared.
  useEffect(() => { if (sheet === null) sheetDrafts.current.clear(); }, [sheet]);

  useEffect(() => subscribe(() => {
    // WHIT-508: a LOCK (not just sign-out) unmounts the whole overlay layer — Overlays' WHIT-268
    // privacy shield returns null for 'locked' too — so the apply-rules sheet's local state dies
    // while the context-held `sheet` survives. On unlock it would remount and fire a SECOND
    // whole-history scan with no memory of the first run. There is no half-typed draft to
    // preserve here, so drop it: the run finishes in the provider, the caches refresh, and the
    // next open previews fresh against whatever actually landed. (No toast survives a lock either
    // way — the same shield unmounts the Toast, and its timer clears it before unlock.)
    // Keyed on the same condition the shield unmounts on (`!== 'authed'`), not on 'anon', so a
    // re-broadcast of 'authed' can't close a sheet the user is still reading.
    if (getStatus() !== 'authed') {
      setSheet((prev) => (prev?.mode === 'applyRules' ? null : prev));
      // WHIT-560: a lock (or sign-out) unmounts the sheet, so stop polling and drop the job view —
      // the job keeps running server-side; on unlock the reopened sheet previews fresh. Releasing
      // the lock here matches the sheet's own lock→fresh-start model (WHIT-508).
      endOnLock();
    }
    if (getStatus() !== 'anon') return;
    sessionEpoch.current += 1;
    clearTimeout(toastTimer.current);
    setSheet(null);
    sheetDrafts.current.clear(); // WHIT-277: wipe any half-typed draft on sign-out (WHIT-268 parity)
    setToast(null);
    setPendingUncategorizedSelect(false); // WHIT-544: don't carry a pending jump into the next session
    setAiInsights(null);
    setAiInsightsError(false);
    setAiInsightsLoading(false);
  }), []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

  // WHIT-544: arm / disarm the one-shot Uncategorized-tab multi-select jump.
  const requestUncategorizedSelect = useCallback(() => setPendingUncategorizedSelect(true), []);
  const clearUncategorizedSelect = useCallback(() => setPendingUncategorizedSelect(false), []);

  // Persist a changed pay cycle: optimistically write the ['payCycle'] cache the
  // migrated sheet + Settings row read, PUT the full cycle (the server replaces both
  // fields together), then invalidate the windowed reads. Roll the cache back + toast
  // on failure. WHIT-192: the caller mutates the CURRENT cached cycle — sourced here
  // via getQueryData, not a store useState. If the ['payCycle'] read hasn't resolved
  // (cold cache) we bail rather than persist a defaulted cycle, which would silently
  // reset the sibling field (e.g. a Monthly user's length). The pay-cycle sheet warms
  // this cache on open, so a cold write is a belt-and-braces guard, not the norm.
  const persistPayCycle = useCallback(
    async (mutate: (prev: { length: number; last_pay_date: string }) => { length: number; last_pay_date: string }) => {
      const prev = queryClient.getQueryData<{ length: number; last_pay_date: string }>(payCycleKey);
      if (!prev) return;
      const next = mutate(prev);
      // Drop any stale server days_left from the optimistic write — the new length/payday
      // changes it, so let cycleClockView fall back to the local cycleClock until the
      // invalidate below refetches the authoritative value (WHIT-341).
      const optimistic = { length: next.length, last_pay_date: next.last_pay_date };
      // WHIT-271: runSave drops a late success/failure after sign-out, so the old cycle is never
      // re-seated nor toasted into the next session.
      return runSave({
        apply: () => {
          queryClient.setQueryData(payCycleKey, optimistic);
          return () => queryClient.setQueryData(payCycleKey, prev);
        },
        send: () => apiSetPayCycle(optimistic),
        onSaved: () => {
          // The window (length and/or payday) changed, so the server rollups move — refetch
          // the migrated Budgets/Insights reads. Also refetch ['payCycle'] so the server's
          // authoritative days_left is recomputed for the new settings (WHIT-341); the flat
          // ['budgets']/['breakdown'] keys make each of these a single refresh (WHIT-72).
          queryClient.invalidateQueries({ queryKey: payCycleKey });
          queryClient.invalidateQueries({ queryKey: budgetsKey });
          queryClient.invalidateQueries({ queryKey: breakdownKey });
        },
        onFailed: () => showToast('Could not save pay cycle. Please try again.'),
        whenSignedOut: undefined,
      });
    },
    [showToast, runSave],
  );

  // Change the window length (Weekly/Fortnightly/Monthly), keeping the last_pay_date.
  const setPayCycleLength = useCallback((length: number) => {
    persistPayCycle((prev) => ({ ...prev, length }));
  }, [persistPayCycle]);

  // Change the last pay date (a real past payday), keeping the length.
  const setPayday = useCallback((last_pay_date: string) => {
    persistPayCycle((prev) => ({ ...prev, last_pay_date }));
  }, [persistPayCycle]);

  // Save the loan-facts form: optimistically write the ['loanFacts'] cache the Goal +
  // Settings reads pull from, PUT the whole object, invalidate to reconcile. Roll the
  // cache back + toast on failure (same optimistic pattern as persistPayCycle/saveBudget).
  // Returns true on success so the form navigates back only when the save stuck. WHIT-192:
  // sources prev from the query cache (EMPTY_LOAN_FACTS when cold — the same default the
  // form shows), not a store useState.
  const saveLoanFacts = useCallback(async (next: LoanFactsInput): Promise<boolean> => {
    const prev = queryClient.getQueryData<LoanFacts>(loanFactsKey) ?? EMPTY_LOAN_FACTS;
    // WHIT-271: a sign-out during the round-trip makes this a no-op — no re-seat of the old mortgage
    // details, no toast, and no `true` (which would fire the form's router.back() post-redirect).
    return runSave({
      apply: () => {
        queryClient.setQueryData(loanFactsKey, next);
        return () => queryClient.setQueryData(loanFactsKey, prev);
      },
      send: () => apiSetLoanFacts(next),
      onSaved: () => {
        queryClient.invalidateQueries({ queryKey: loanFactsKey });
        return true;
      },
      onFailed: () => {
        showToast('Could not save loan details. Please try again.');
        return false;
      },
      whenSignedOut: false,
    });
  }, [showToast, runSave]);

  // Save the milestone editor's plan: optimistically write the ['milestones'] cache the milestone
  // + mortgage screens read, PUT the whole ordered list, invalidate to reconcile. Roll the cache
  // back + toast on failure — the same optimistic pattern as saveLoanFacts. The invalidate is
  // load-bearing: milestones is SECONDARY in useGoalScreenData (out of that composite's refetch),
  // so this save's own invalidation is what refreshes the screen (WHIT-367 wired it that way).
  const saveMilestones = useCallback(async (next: MilestoneRecord[]): Promise<boolean> => {
    const prev = queryClient.getQueryData<MilestoneRecord[]>(milestonesKey) ?? [];
    // WHIT-271: a sign-out during the round-trip makes this a no-op — no re-seat of the old plan,
    // no toast, and no `true` (which would fire the editor's router.back() post-redirect).
    return runSave({
      apply: () => {
        queryClient.setQueryData(milestonesKey, next);
        return () => queryClient.setQueryData(milestonesKey, prev);
      },
      send: () => apiSetMilestones(next),
      onSaved: () => {
        queryClient.invalidateQueries({ queryKey: milestonesKey });
        return true;
      },
      onFailed: () => {
        showToast('Could not save milestones. Please try again.');
        return false;
      },
      whenSignedOut: false,
    });
  }, [showToast, runSave]);

  const openPicker = useCallback((txId: string) => setSheet({ mode: 'picker', txId }), []);
  // WHIT-291: open the picker for a captured set of ids. A no-op on an empty set (nothing to file).
  const openMultiPicker = useCallback((txIds: string[]) => { if (txIds.length) setSheet({ mode: 'pickerMany', txIds }); }, []);
  const openGoalBalance = useCallback((goalId: string) => setSheet({ mode: 'goalbalance', goalId }), []);
  // Advance the picker to its confirm step, carrying whichever target the picker held: a single
  // charge or a multi-select set (WHIT-291).
  const chooseCategory = useCallback(
    (categoryId: string) => setSheet((s) => {
      if (s && s.mode === 'picker') return { mode: 'confirm', txId: s.txId, categoryId };
      if (s && s.mode === 'pickerMany') return { mode: 'confirmMany', txIds: s.txIds, categoryId };
      return s;
    }),
    [],
  );

  // WHIT-190a/WHIT-275: optimistic tx edits go straight into the ['transactions'] feed cache
  // the tab list + budget detail + detail screen read. Maps the row transform over each loaded
  // feed page (patchTransactionsCache), so an edit to a row on any paged-in batch updates in
  // place. Guards an evicted/absent cache (gcTime is finite). Lifted out of applyCategory so the
  // note/tag edit action reuses the exact same cache-patch primitive.
  const patchTransactions = useCallback((fn: (prev: Transaction[]) => Transaction[]) => {
    patchTransactionsCache(fn);
  }, []);

  const applyCategory = useCallback(async (scope: 'one' | 'all'): Promise<void> => {
    // This is only ever triggered from the confirm sheet; ignore any other state.
    if (!sheet || sheet.mode !== 'confirm') return;
    const { txId, categoryId } = sheet;
    // WHIT-192: source the transactions + taxonomy from the query cache the screens read
    // (the eager store is gone). By the time the confirm sheet is open the Transactions
    // list + pickers have warmed both caches; an empty fallback just closes the sheet.
    const transactions = readTransactionCopies(queryClient, { includeScopedLists: false });
    const categories = queryClient.getQueryData<Category[]>(categoriesKey) ?? [];
    const transaction = transactions.find((t) => t.transaction_id === txId);
    const category = categories.find((c) => c.id === categoryId);
    if (!transaction || !category) {
      setSheet(null); // nothing to categorise — just close the sheet
      return;
    }
    if (scope === 'all') {
      // "Every {merchant} charge": every OTHER uncategorised transaction from the
      // same merchant (matched by description) that counts toward a budget. Captured
      // once so the optimistic update and the failure-revert act on the same set.
      // Match future charges on a generalised merchant pattern, and categorise the
      // CURRENT uncategorised charges the rule will catch — but gated to the SAME
      // merchant (matchesRulePattern) so a promiscuous token can't sweep in a
      // different merchant's charge. "Uncategorised" here MUST mean the same thing
      // the app shows (categoryIsUnmapped): null OR a raw BankSync enum (e.g.
      // FOOD_AND_DRINK) that isn't a user category — a plain `category == null`
      // check silently skipped enum-tagged charges the user sees as Uncategorized.
      const ruleValue = rulePattern(transaction);
      const sweepIds = transactions
        .filter((t) =>
          contributesToBudget(t) &&
          categoryIsUnmapped(t.category, (id) => categories.find((c) => c.id === id)) &&
          matchesRulePattern(t, ruleValue, transaction))
        .map((t) => t.transaction_id);
      // WHIT-324: always re-file the TAPPED charge too. On the list flow it's uncategorised, so
      // it's already in the sweep; but the detail screen can open this confirm on an
      // already-categorised charge, which categoryIsUnmapped filters out of the sweep. The
      // tapped charge is the user's explicit pick, so include it regardless of its current state.
      const sameMerchantIds = sweepIds.includes(txId) ? sweepIds : [txId, ...sweepIds];
      // Optimistically file all of them under the chosen category; the rollback reverts each
      // failed one to what it ACTUALLY was (WHIT-324) and restores the old budget's list (WHIT-348).
      const rollback = optimisticRefile(sameMerchantIds, categoryId, categories);

      // WHIT-355: don't mint a second rule when one already matches this pattern. Only CREATE a
      // new rule when there's no existing same-pattern rule. A same-category one already does the
      // job (duplicate) and a different-category one is a conflict we SURFACE but never silently
      // change — this tap has no Replace/Cancel dialog, so the user resolves it in the Rules
      // screen (mirrors the sheet, which only retargets a rule on an explicit Replace).
      // WHIT-491: BankSync matches future charges by a literal `contains` on the ONE stored
      // value, so a single rule can't span two spellings of the same merchant (ANZ's spaced
      // `UNIFLEX REMEDIAL MASSAGE` vs Westpac's `UNIFLEXREMEDIALMASSAGE`). Mint one rule per
      // distinct GENUINE spelling among the swept charges so both banks' spellings file going
      // forward. Candidates: the tapped charge's own pattern (unchanged — it always gets a rule,
      // even a full-description fallback) PLUS each swept charge's merchant slice ONLY when it's a
      // real merchant substring (merchantSlice != null), never the full-description fallback — so a
      // noisy no-merchant pending auth in the sweep can't mint a match-nothing rule.
      const existingRules = queryClient.getQueryData<Rule[]>(rulesKey) ?? [];
      const candidateValues = [
        ruleValue,
        ...sameMerchantIds
          .map((id) => transactions.find((t) => t.transaction_id === id))
          .map((swept) => (swept ? merchantSlice(swept) : null))
          .filter((value): value is string => value !== null),
      ];
      // Dedup by rule identity (folds case + whitespace) into the spellings to mint. Each mint
      // gets a UNIQUE temp id so the optimistic add + per-rule reconcile below never target the
      // wrong row. A same-category duplicate is skipped (a rule already does the job); the first
      // cross-category clash is remembered to surface in the toast (WHIT-355 behaviour, per rule).
      const seenIdentities = new Set<string>();
      const mints: { value: string; tempId: string }[] = [];
      let existingConflict: RuleConflict | null = null;
      for (const value of candidateValues) {
        const identity = normaliseRuleIdentity(value);
        if (!identity || seenIdentities.has(identity)) continue;
        seenIdentities.add(identity);
        const conflict = ruleConflict(existingRules, value, categoryId);
        if (conflict === null) {
          mints.push({ value, tempId: `tmp-${Date.now()}-${mints.length}` });
        } else if (conflict.kind === 'conflict' && existingConflict === null) {
          existingConflict = conflict;
        }
      }

      // WHIT-292: word the toast for what actually happened, naming the count it just filed.
      // WHIT-324: the tapped charge is always in the set now, so the count is ≥ 1; the rule-only
      // copy stays only as a defensive fallback for a somehow-empty set.
      const merchantWord = cleanName(transaction.description);
      const sweepCount = sameMerchantIds.length;
      const countWord = sweepCount === 1 ? 'transaction' : 'transactions';
      let sweepToast: string;
      if (existingConflict?.kind === 'conflict') {
        // A rule already files this merchant elsewhere — file the tapped charges, but tell the
        // user about the clash instead of adding a second, fighting rule (WHIT-355).
        const otherName = categories.find((c) => c.id === existingConflict.existing.categoryId)?.name ?? 'another category';
        sweepToast = sweepCount > 0
          ? `${sweepCount} ${countWord} filed. You already have a rule filing ${merchantWord} as ${otherName} — edit it in Rules to change it.`
          : `You already have a rule filing ${merchantWord} as ${otherName} — edit it in Rules to change it.`;
      } else if (sweepCount > 0) {
        sweepToast = `${sweepCount} ${countWord} filed — future ${merchantWord} charges file as ${category.name}.`;
      } else {
        sweepToast = `Rule saved — future ${merchantWord} charges file as ${category.name}.`;
      }
      showToast(sweepToast);
      setSheet(null); // close the confirm sheet

      // Optimistically add each minted rule (none on all-duplicate/all-conflict). Each keeps its
      // own temp id so we can swap in the server id or roll it back independently.
      if (mints.length > 0) {
        patchRules((prev) => [
          ...mints.map((mint) => ({ id: mint.tempId, pattern: mint.value, categoryId, isNew: true })),
          ...prev,
        ]);
      }

      // Persist the rule AND all the categorisations CONCURRENTLY. The rule hits BankSync;
      // the charges go through persistCategoryBatch (the batch endpoint, WHIT-70, chunked
      // under the server cap) — shared with applyCategoryToMany since WHIT-292. Wrapping the
      // rule call in Promise.allSettled BEFORE awaiting the batch attaches its rejection
      // handler synchronously, so a rule failure can never float as an unhandled rejection
      // while the batch is in flight; issuing it first preserves the prior rule-before-charges
      // call order. The runner owns the session check: after sign-out none of the reconcile,
      // rollback, toasts or refresh below run.
      await runSave({
        send: async () => {
          const ruleSettled = mints.length > 0
            ? Promise.allSettled(mints.map((mint) => createRule({ value: mint.value, categoryId })))
            : null;
          const { failedIds } = await persistCategoryBatch(sameMerchantIds, categoryId);
          const ruleOutcomes = ruleSettled ? await ruleSettled : [];
          return { failedIds, ruleOutcomes };
        },
        // Partial-failure undo lives in onSaved because persistCategoryBatch never throws.
        onSaved: ({ failedIds, ruleOutcomes }) => {
          // Reconcile each optimistic rule against ITS OWN temp id (allSettled preserves order, so
          // outcome i belongs to mints[i]): swap in the real BankSync id on success (so a later
          // delete targets the real rule), or remove just that temp row on failure — the others stand.
          ruleOutcomes.forEach((outcome, i) => {
            const { tempId } = mints[i];
            if (outcome.status === 'fulfilled') {
              // Keep isNew so the "NEW" badge survives settlement (toRule defaults it
              // false for the load path, where rules genuinely aren't new).
              patchRules((prev) => prev.map((r) => (r.id === tempId ? { ...toRule(outcome.value), isNew: true } : r)));
            } else {
              patchRules((prev) => prev.filter((r) => r.id !== tempId));
            }
          });
          const anyRuleRejected = ruleOutcomes.some((outcome) => outcome.status === 'rejected');
          if (failedIds.length > 0) {
            rollback(failedIds);
            showToast('Could not save some categories. Please try again.');
          } else if (anyRuleRejected) {
            // Transactions filed fine; at least one future-rule failed to persist.
            showToast('Filed, but could not save the rule for future charges.');
          }
          if (failedIds.length < sameMerchantIds.length) refreshAfter('refile');
        },
        onFailed: () => {
          rollback(sameMerchantIds);
          const tempIds = mints.map((mint) => mint.tempId);
          patchRules((prev) => prev.filter((r) => !tempIds.includes(r.id)));
          showToast('Could not save some categories. Please try again.');
        },
        whenSignedOut: undefined,
      });
      return;
    }

    // scope === 'one': just this single transaction.
    const rollback = optimisticRefile([txId], categoryId, categories);
    showToast(`This transaction filed under ${category.name}.`);
    setSheet(null); // close the confirm sheet

    await runSave({
      send: () => apiSetTransactionCategory(txId, categoryId),
      onSaved: () => refreshAfter('refile'),
      onFailed: () => {
        rollback([txId]);
        showToast('Could not save category. Please try again.');
      },
      whenSignedOut: undefined,
    });
  }, [sheet, showToast, patchRules, runSave]);

  // WHIT-291: re-file a captured SET of transactions under one category in a single action
  // (multi-select). This is applyCategory's 'all' batch path WITHOUT the merchant rule/sweep —
  // the ids are exactly what the user selected. Optimistically patch the cache, batch-persist in
  // chunks under the server cap, then reconcile BY ID and roll back only the ones that failed to
  // their PREVIOUS category (never a blanket null — a re-filed charge may have been categorised).
  const applyCategoryToMany = useCallback(async (txIds: string[], categoryId: string): Promise<void> => {
    const transactions = readTransactionCopies(queryClient, { includeScopedLists: false });
    const categories = queryClient.getQueryData<Category[]>(categoriesKey) ?? [];
    const category = categories.find((c) => c.id === categoryId);
    // Only touch ids that are actually in the cache; dedupe defensively.
    const ids = Array.from(new Set(txIds)).filter((id) => transactions.some((t) => t.transaction_id === id));
    if (!category || ids.length === 0) { setSheet(null); return; }

    const rollback = optimisticRefile(ids, categoryId, categories);
    showToast(ids.length === 1
      ? `This transaction filed under ${category.name}.`
      : `${ids.length} transactions filed under ${category.name}.`);
    setSheet(null); // close the confirm sheet

    // Batch-persist in chunks under the server cap and reconcile BY ID (shared with
    // applyCategory('all') since WHIT-292). A rejected/malformed chunk leaves its ids in
    // failedIds -> rolled back to their previous category.
    await runSave({
      send: () => persistCategoryBatch(ids, categoryId),
      // Partial-failure undo lives in onSaved because persistCategoryBatch never throws.
      onSaved: ({ failedIds }) => {
        if (failedIds.length > 0) {
          rollback(failedIds);
          showToast('Could not save some categories. Please try again.');
        }
        if (failedIds.length < ids.length) refreshAfter('refile');
      },
      onFailed: () => {
        rollback(ids);
        showToast('Could not save some categories. Please try again.');
      },
      whenSignedOut: undefined,
    });
  }, [showToast, runSave]);

  // WHIT-508: bring the server-derived reads back in line after an apply-rules run.
  //
  // Ordering matters. Invalidating an InfiniteData refetches EVERY loaded page sequentially (a
  // storm), and each page of the now-sparse uncategorized feed makes
  // the server re-walk up to its own scan cap. So trim to page 1 FIRST, then invalidate: one round
  // trip. `resetQueries` would also avoid the storm but drops the data, and the tab's cold-load
  // gate is `isLoading && transactions.length === 0` — so the list would blank to a spinner right
  // after a successful bulk file. Trimming keeps page 1 on screen while it refetches.
  //
  // The trim mirrors refetchList's (queries.ts), which then calls `refetch()` because it holds the
  // hook. The provider doesn't, and the sheet can be opened with no active feed observer, so this
  // half invalidates instead — a refetch on a hook we don't own isn't available, and invalidate
  // correctly just marks stale when nothing is watching.
  //
  // ['transactions'] is deliberately NOT invalidated: on the success path the reconcile below has
  // already written the change into that cache, and an invalidate would storm it. On the FAILURE
  // path there is no reconcile, so the All tab and the recent window can hold a stale category for
  // up to their 45s staleTime — accepted: the storm argument still holds, the Uncategorized tab and
  // the badge (the numbers this feature is about) are correct immediately, and focus reconciles the
  // rest. The sheet's failure copy is worded to match, claiming only the unfiled list and count.
  // `skipRules` leaves the ['rules'] cache alone. WHIT-538's new-rule filing has already prepended the
  // minted rule optimistically (with its "NEW" badge); invalidating here would refetch and reset
  // that badge to false, so it flashes then vanishes. Every other caller mints no rule (or mints
  // one it does NOT show optimistically), so they invalidate as before.
  const refreshAfterApplyRules = useCallback(
    (opts?: { skipRules?: boolean }) => refreshAfter('rulesApplied', opts),
    [],
  );

  // WHIT-275: edit one transaction's note and/or tags, mirroring applyCategory's
  // single-transaction path — snapshot the current values, optimistically patch the
  // ['transactions'] cache the detail screen reads, persist, and roll back on failure.
  // `patch` carries only the fields being changed, so a note edit never clobbers tags
  // (and vice-versa); a passed "" note / [] tags clears that field on the server.
  const applyTransactionEdit = useCallback(
    async (txId: string, patch: { notes?: string; tags?: string[]; budget_excluded?: boolean }): Promise<void> => {
      // A charge opened from a budget-detail or category drill-in list may live ONLY there (an
      // older one-off, off the recent window), so this lookup includes those lists.
      const transaction = findTransaction(txId, { includeScopedLists: true });
      if (!transaction) return; // cache evicted / unknown id — nothing to edit

      // Snapshot only the fields we're about to change, so a failed save restores
      // exactly them (undefined restores an absent field, not an empty value).
      const previous: { notes?: string; tags?: string[]; budget_excluded?: boolean } = {};
      if ('notes' in patch) previous.notes = transaction.notes;
      if ('tags' in patch) previous.tags = transaction.tags;
      if ('budget_excluded' in patch) previous.budget_excluded = transaction.budget_excluded;

      // Stamp `fields` onto this txId wherever it appears; leave other rows untouched.
      const stamp = (fields: Partial<Transaction>) => (row: Transaction) =>
        (row.transaction_id === txId ? { ...row, ...fields } : row);

      // WHIT-525: stamp the row in every copy, including both scoped lists (budget + category).
      // The old approach (WHIT-344) removed the row from budgetTransactions, which blanked a
      // budget-only charge's detail screen to "not found." Now the row stays findable;
      // budgetDetail filters out excluded rows at the view-model level so the budget list still
      // drops them visually. Re-including (budget_excluded: false) still relies on the refresh.
      // WHIT-271: the runner owns the session check, so a save settling after sign-out neither
      // undoes into the next account's data nor toasts into its session.
      return runSave({
        apply: () => {
          patchAllCopies(stamp(patch));
          return () => patchAllCopies(stamp(previous));
        },
        send: () => apiSetTransactionFields(txId, patch),
        onSaved: () => {
          // A note/tag edit touches no server-derived total, so only an exclude refreshes.
          if ('budget_excluded' in patch) refreshAfter('budgetExclusion');
        },
        onFailed: () => showToast('Could not save. Please try again.'),
        whenSignedOut: undefined,
      });
    },
    [showToast, runSave],
  );

  // Delete one charge, e.g. a duplicate (WHIT-654). Drop it from every copy at once; on failure
  // put every copy back and warn. Resolves true only when the server deleted it, so the detail
  // screen leaves only then.
  const deleteTransaction = useCallback(
    (txId: string): Promise<boolean> => runSave({
      apply: () => removeFromAllCopies(txId),
      send: () => apiDeleteTransaction(txId),
      onSaved: () => {
        refreshAfter('transactionDeleted');
        return true;
      },
      onFailed: () => {
        showToast('Could not delete. Please try again.');
        return false;
      },
      whenSignedOut: false,
    }),
    [showToast, runSave],
  );

  const saveBudget = useCallback(
    async (categoryId: string, value: number, rollover?: boolean): Promise<boolean> => {
      if (value <= 0) return false;
      // WHIT-192: the toast copy needs the category name + whether a budget already
      // existed — both sourced from the query cache the screens read (the store is gone).
      // The ['budgets'] cache holds the RAW queryFn output, a Record<categoryId, BudgetRollup>
      // keyed by id — useBudgetsQuery maps it to Budget[] via `select`, which getQueryData
      // does NOT apply. Read it via getQueriesData (prefix ['budgets']) and look the id up as
      // a KEY (a target>0 rollup is a real budget row, matching selectBudgets' own filter).
      // Treating it as an array here would throw `.some is not a function` on the Record.
      // (WHIT-72 flattened the key to ['budgets']; the prefix match still finds it.)
      const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
      // WHIT-202: a Savings-bucket category can't carry a target — the screens skip it
      // (budgetViews/budgetDetail), so a saved one is an invisible, un-editable phantom.
      // Short-circuit before the doomed round-trip; the server rejects it too (belt +
      // braces) for the deep-link back door. On a cold ['categories'] cache c is undefined
      // and this can't fire — the server 400 is the backstop (a generic save-failed toast).
      if (c?.bucket === 'Savings') {
        showToast("Savings categories can't be budgeted.");
        return false;
      }
      const existing = queryClient
        .getQueriesData<Record<string, BudgetRollup>>({ queryKey: budgetsKey })
        .some(([, data]) => !!data && (data[categoryId]?.target ?? 0) > 0);
      // WHIT-271: `c` (category name) + `saved.target` (dollar figure) are the OLD session's data,
      // and app/budget/edit.tsx invalidates + navigates on `true` — runSave returns false after a
      // mid-save sign-out so neither reaches the next session.
      return runSave({
        // Pass rollover only when the caller supplied it — a plain amount save (no rollover
        // arg) leaves the stored flag untouched, so the API omits it from the body.
        send: () => (rollover === undefined
          ? apiSetBudget(categoryId, value)
          : apiSetBudget(categoryId, value, rollover)),
        onSaved: (saved) => {
          // The Budgets screen reads ['budgets'] and app/budget/edit.tsx invalidates it after
          // this returns true, so the just-saved target reconciles from the server rollup —
          // no optimistic cache write needed here.
          if (c) showToast(`${c.name} budget ${existing ? 'updated' : 'set'} to ${fmt(saved.target)}.`);
          return true;
        },
        onFailed: () => {
          showToast('Could not save budget. Please try again.');
          return false;
        },
        whenSignedOut: false,
      });
    },
    [showToast, runSave],
  );

  // WHIT-505: spread a one-off bill over the coming cycles. Non-optimistic — invalidates
  // ['budgets'] here so the plan reconciles from the server rollup (self-contained, matching
  // removeSpread below; the caller just navigates). The category name (for the toast) comes
  // from the ['categories'] cache; every post-await toast/return is gated on the session epoch
  // (WHIT-271) so a mid-save sign-out never toasts into or navigates the next user's session.
  const saveSpread = useCallback(
    async (categoryId: string, amount: number, cycles: number): Promise<boolean> => {
      if (amount <= 0 || cycles < SPREAD_MIN_CYCLES || cycles > SPREAD_MAX_CYCLES) return false;
      const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
      return runSave({
        send: () => apiSetSpread(categoryId, amount, cycles),
        onSaved: () => {
          queryClient.invalidateQueries({ queryKey: budgetsKey });
          if (c) showToast(`Bill spread set for ${c.name}.`);
          return true;
        },
        onFailed: () => {
          showToast('Could not set the bill spread. Please try again.');
          return false;
        },
        whenSignedOut: false,
      });
    },
    [showToast, runSave],
  );

  // WHIT-505: remove a category's bill spread. Non-optimistic (invalidate + refetch), matching
  // saveSpread beside it — the writer touches the query cache, never screen state, so a popped
  // screen can't setState-after-unmount. Idempotent server-side (200 with no plan).
  const removeSpread = useCallback(
    async (categoryId: string): Promise<boolean> => {
      const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
      return runSave({
        send: () => apiDeleteSpread(categoryId),
        onSaved: () => {
          queryClient.invalidateQueries({ queryKey: budgetsKey });
          if (c) showToast(`Bill spread removed for ${c.name}.`);
          return true;
        },
        onFailed: () => {
          showToast('Could not remove the bill spread. Please try again.');
          return false;
        },
        whenSignedOut: false,
      });
    },
    [showToast, runSave],
  );

  // WHIT-203: remove a category's budget target (the Budget detail screen's Delete). The
  // category and its transactions are untouched — only the pay-cycle target is dropped, so
  // the category simply stops appearing on the Budgets tab. Optimistically strips the id from
  // every ['budgets', cycleLen] cache entry (a Record keyed by id — the raw queryFn output the
  // Budgets screen reads), rolling the snapshots back on failure, then invalidates to reconcile
  // with the server rollup.
  const deleteBudget = useCallback(
    async (categoryId: string): Promise<boolean> => {
      const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
      // WHIT-271: runSave skips the restore after sign-out, so stale rollups never reach the
      // cleared cache, and no toast reaches the next session.
      return runSave({
        apply: () => {
          // Snapshot every ['budgets'] entry so a failure can restore exactly what was there.
          const snapshots = queryClient.getQueriesData<Record<string, BudgetRollup>>({ queryKey: budgetsKey });
          snapshots.forEach(([key, data]) => {
            if (!data || !(categoryId in data)) return;
            const { [categoryId]: _removed, ...rest } = data;
            queryClient.setQueryData<Record<string, BudgetRollup>>(key, rest);
          });
          return () => snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
        },
        send: () => apiDeleteBudget(categoryId),
        onSaved: () => {
          queryClient.invalidateQueries({ queryKey: budgetsKey });
          if (c) showToast(`${c.name} budget removed.`);
          return true;
        },
        onFailed: () => {
          showToast('Could not remove budget. Please try again.');
          return false;
        },
        whenSignedOut: false,
      });
    },
    [showToast, runSave],
  );

  // Create a category and RETURN it (not just a boolean), so a caller can act on the new
  // id straight away — the categorise sheet files the transaction into it (WHIT-238), the
  // category-edit screen re-parents children under it (WHIT-237). Mirrors the new row into
  // the ['categories'] cache the pickers/screens read (so it's pickable instantly), then
  // invalidates to reconcile. Returns null (and toasts) on a bad/empty name or an API error.
  const createCategoryInline = useCallback(
    // WHIT-240: `opts.silent` lets an orchestrated bulk save (category/edit) suppress this
    // writer's own toast so the screen can show ONE summary toast instead of one per write.
    async (form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }): Promise<Category | null> => {
      const name = form.name.trim();
      if (!name) return null;
      // Send `parent` only when supplied (server leave-as-is otherwise); explicit null = top-level.
      const input = 'parent' in form
        ? { name, bucket: form.bucket, icon: form.icon, parent: form.parent ?? null }
        : { name, bucket: form.bucket, icon: form.icon };
      // WHIT-271: after a mid-save sign-out runSave returns null, so callers (the categorise sheet's
      // createAndFile, app/category/edit.tsx) don't act on it, and the non-id-keyed append below
      // never plants this category into the next session's list. It neither toasts nor throws:
      // the caller's own epoch check owns the bail (WHIT-282).
      return runSave({
        send: async () => toCategory(await createCategory(input)),
        onSaved: (created) => {
          queryClient.setQueryData<Category[]>(categoriesKey, (prev) => (prev ? [...prev, created] : prev));
          queryClient.invalidateQueries({ queryKey: categoriesKey });
          if (!opts?.silent) showToast('Category created.');
          return created;
        },
        onFailed: (error): Category | null => {
          // WHIT-437: `silent` means "I don't toast" — so hand the caller the error to speak with.
          // app/category/edit.tsx folds the reason into its one summary toast.
          if (opts?.silent) throw error;
          showToast(writeFailureMessage(error, 'Could not save category. Please try again.'));
          return null;
        },
        whenSignedOut: null,
      });
    },
    [showToast, runSave],
  );

  const saveCategory = useCallback(
    async (editId: string | null, form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }): Promise<boolean> => {
      const name = form.name.trim();
      if (!name) return false;
      // Create routes through createCategoryInline (the single source of the cache-mirror);
      // update stays here. `parent` is forwarded as-is so an omitted parent leaves the stored
      // link untouched (the server's leave-as-is rule); an explicit null detaches to top-level.
      // WHIT-240: forward `opts` so a silent bulk save stays silent through the create path too.
      if (!editId) return (await createCategoryInline(form, opts)) !== null;
      const input = 'parent' in form
        ? { name, bucket: form.bucket, icon: form.icon, parent: form.parent ?? null }
        : { name, bucket: form.bucket, icon: form.icon };
      // WHIT-271: runSave returns false after a mid-save sign-out so app/category/edit.tsx doesn't
      // run its summary toast + router.back() in the next session.
      return runSave({
        send: () => updateCategory(editId, input),
        onSaved: (updated) => {
          const previousName = queryClient.getQueryData<Category[]>(categoriesKey)?.find((c) => c.id === editId)?.name;
          queryClient.setQueryData<Category[]>(categoriesKey, (prev) => (prev ? prev.map((c) => (c.id === editId ? toCategory(updated) : c)) : prev));
          // WHIT-203: the setQueryData shows the change instantly on the migrated screens /
          // pickers; the invalidate then reconciles with the server.
          queryClient.invalidateQueries({ queryKey: categoriesKey });
          // WHIT-576: a rename changes the category text a search matches on.
          if (updated.name !== previousName) queryClient.invalidateQueries({ queryKey: transactionsSearchKey });
          if (!opts?.silent) showToast('Category updated.');
          return true;
        },
        onFailed: (error) => {
          if (opts?.silent) throw error; // WHIT-437, as above
          showToast(writeFailureMessage(error, 'Could not save category. Please try again.'));
          return false;
        },
        whenSignedOut: false,
      });
    },
    [showToast, createCategoryInline, runSave],
  );

  const deleteCategory = useCallback(async (id: string): Promise<boolean> => runSave({
    apply: () => {
      // Client-side cascade into the query caches the migrated screens read (category
      // list, budget screens, tab badge, pickers). setQueryData — NOT invalidate —
      // because the server does no cascade, so a refetch would resurrect the just-dropped
      // budget/rule/txn-tag (cosmetic: those txns re-appear with the dangling id and
      // render as Uncategorized via isUncategorized). The ['budgets'] cache holds the RAW
      // Record<categoryId, BudgetRollup> (not the select'd Budget[]), so drop the deleted
      // id's KEY from the Record — filtering it as an array would throw `.filter is not a
      // function` and abort the rest of the cascade.
      // The undo restores whole snapshots, so a change to categories/rules/budgets made while
      // the delete is in flight is lost on failure (rare: the delete is modal).
      const categoriesBefore = queryClient.getQueryData<Category[]>(categoriesKey);
      const rulesBefore = queryClient.getQueryData<Rule[]>(rulesKey);
      const budgetSnapshots = queryClient.getQueriesData<Record<string, BudgetRollup>>({ queryKey: budgetsKey });
      const unfiledIds = new Set(
        readTransactionCopies(queryClient, { includeScopedLists: true })
          .filter((t) => t.category === id)
          .map((t) => t.transaction_id),
      );
      queryClient.setQueryData<Category[]>(categoriesKey, (prev) => prev?.filter((c) => c.id !== id));
      budgetSnapshots.forEach(([key, data]) => {
        if (!data || !(id in data)) return;
        const { [id]: _removed, ...rest } = data;
        queryClient.setQueryData<Record<string, BudgetRollup>>(key, rest);
      });
      patchRules((prev) => prev.filter((r) => r.categoryId !== id));
      patchAllCopies((t) => (t.category === id ? { ...t, category: null } : t));
      return () => {
        queryClient.setQueryData(categoriesKey, categoriesBefore);
        queryClient.setQueryData(rulesKey, rulesBefore);
        budgetSnapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
        patchAllCopies((t) => (unfiledIds.has(t.transaction_id) ? { ...t, category: id } : t));
      };
    },
    send: () => apiDeleteCategory(id),
    onSaved: () => {
      // The deleted category's spend and charges now count as Uncategorized. Deleting a category
      // is rare, so refetching the paged uncategorized feed and the charge lists here is cheap.
      refreshAfter('categoryDeleted');
      showToast('Category deleted.');
      return true;
    },
    onFailed: (error) => {
      showToast(writeFailureMessage(error, 'Could not delete category. Please try again.'));
      return false;
    },
    // WHIT-271: false (not just no toast) so app/category/edit.tsx's `if (ok)` doesn't
    // router.back() the next session after a mid-delete sign-out.
    whenSignedOut: false,
  }), [showToast, patchRules, runSave]);

  // Optimistically remove the rule, then delete it in BankSync; on failure put it back in
  // front of the row that followed it (WHIT-254 — a saved index would misplace it when two
  // deletes fail at once) and tell the user. A temp-id rule (mid-create) deletes fine too —
  // the server DELETE is idempotent (unknown id -> 200), and a refresh reconciles any brief
  // create/delete race.
  const deleteRule = useCallback(async (id: string) => {
    // WHIT-192: source the rules snapshot (for the rollback) from the ['rules'] query cache
    // the screen reads, not a store useState.
    const current = queryClient.getQueryData<Rule[]>(rulesKey) ?? [];
    const index = current.findIndex((r) => r.id === id);
    if (index === -1) return;
    const removed = current[index];
    const successorIds = current.slice(index + 1).map((r) => r.id);
    // WHIT-540: deleting a rule now UNDOES the fills it left on stored charges (the server clears
    // them back to unfiled), so the server-derived reads DO move — refresh the count, feed, budgets
    // and merchant groups. `skipRules` leaves the ['rules'] cache alone: the optimistic removal
    // already dropped this rule, and a refetch would just race that.
    // WHIT-271: runSave skips the undo after sign-out — reinsertBefore appends the rule when its
    // successorIds aren't found, so on the NEXT session's repopulated ['rules'] cache it would
    // plant this rule into that account.
    await runSave({
      apply: () => {
        patchRules((prev) => prev.filter((r) => r.id !== id));
        return () => patchRules((prev) => reinsertBefore(prev, removed, successorIds));
      },
      send: () => apiDeleteRule(id),
      onSaved: () => refreshAfterApplyRules({ skipRules: true }),
      onFailed: () => showToast('Could not delete rule. Please try again.'),
      whenSignedOut: undefined,
    });
  }, [showToast, patchRules, refreshAfterApplyRules, runSave]);

  // Optimistically add the rule (temp id), create it in BankSync, then swap in the
  // real id — or remove it and warn on failure. Value is sent as typed (trimmed,
  // not upper-cased) so both rule-creation paths POST a consistent `value`.
  const saveManualRule = useCallback(async (pattern: string, categoryId: string, budgetExcluded = false, write?: RuleWrite, spread = false) => {
    // WHIT-563: a multi-condition rule has no single pattern — its stored value is the first
    // condition's value (what the server derives too), so both paths key the optimistic row + toast
    // off `value`.
    const value = write ? write.conditions[0].value : pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: the toast copy needs the category name — sourced from the ['categories']
    // query cache the screens read, not a store useState.
    const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
    const tempRuleId = 'tmp-' + Date.now();
    const optimistic: Rule = write
      ? { id: tempRuleId, pattern: value, categoryId, isNew: true, budgetExcluded, spread, field: write.conditions[0].field, operator: write.conditions[0].operator, conditions: write.conditions, logic: write.logic }
      : { id: tempRuleId, pattern: value, categoryId, isNew: true, budgetExcluded, spread };
    // WHIT-502: a new rule only files FUTURE charges (the webhook applies rules as charges land); no stored
    // charge changes category here, so ['uncategorizedCount'] is intentionally NOT invalidated. Any later
    // bank-side re-tag arrives via the webhook, already covered by the count's staleTime + pull-to-refresh.
    await runSave({
      apply: () => {
        patchRules((prev) => [optimistic, ...prev]);
        setSheet(null);
        // WHIT-563: a multi-condition rule's `value` is just the first condition's raw value (an
        // account id or a direction token for those fields), so it isn't shown — the toast names the
        // category only. A classic single rule still quotes its readable pattern.
        if (c) showToast(write ? `Rule added — files as ${c.name}.` : `Rule added — ${value} files as ${c.name}.`);
        return () => patchRules((prev) => prev.filter((r) => r.id !== tempRuleId));
      },
      send: () => createRule(write ? { conditions: write.conditions, logic: write.logic, categoryId, budgetExcluded, spread } : { value, categoryId, budgetExcluded, spread }),
      onSaved: (created) => {
        // Keep isNew so the "NEW" badge survives settlement (toRule defaults it
        // false for the load path, where rules genuinely aren't new).
        patchRules((prev) => prev.map((r) => (r.id === tempRuleId ? { ...toRule(created), isNew: true } : r)));
        // WHIT-542: this shop now has a rule, so it is no longer a hand-filing habit. The "file now"
        // arm reaches this via refreshAfterApplyRules; the "save rule only" arm (here) mints without a
        // sweep, so invalidate the suggestions itself or an accepted "make a rule?" card lingers.
        queryClient.invalidateQueries({ queryKey: filingSuggestionsKey });
      },
      onFailed: (e) => showToast(ruleWriteErrorMessage(e, 'Could not save rule. Please try again.', spread)),
      whenSignedOut: undefined,
    });
  }, [showToast, patchRules, runSave]);

  // Optimistically edit a rule in place, then PUT it; roll back to the snapshot on
  // failure. The rule's field/operator are preserved (passed through) so a
  // non-default rule isn't silently reset to description/contains.
  const updateRule = useCallback(async (id: string, pattern: string, categoryId: string, budgetExcluded = false, write?: RuleWrite, spread = false) => {
    const value = write ? write.conditions[0].value : pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: source the `before` snapshot (for rollback) + the category name from the
    // query caches the screens read, not store useStates.
    const before = queryClient.getQueryData<Rule[]>(rulesKey)?.find((r) => r.id === id);
    if (!before) return;
    // WHIT-563: carry conditions/logic on a multi edit; explicitly null them on a classic edit so an
    // edit that reduces a multi rule to one condition doesn't leave stale rows on the optimistic copy
    // (the server settle replaces the row wholesale, but the interim must be consistent too).
    const patch = write
      ? { pattern: value, categoryId, budgetExcluded, spread, field: write.conditions[0].field, operator: write.conditions[0].operator, conditions: write.conditions, logic: write.logic }
      : { pattern: value, categoryId, budgetExcluded, spread, conditions: null, logic: null };
    const c = queryClient.getQueryData<Category[]>(categoriesKey)?.find((x) => x.id === categoryId);
    // WHIT-540: editing a rule now RE-FILES the stored charges it already touched (the server moves
    // them to the new target, or clears the ones the edit no longer matches), so the server-derived
    // reads DO move — refresh the count, feed, budgets and merchant groups. `skipRules` leaves the
    // ['rules'] cache alone: the optimistic edit already patched this rule's row.
    await runSave({
      apply: () => {
        patchRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
        setSheet(null);
        if (c) showToast(write ? `Rule updated — files as ${c.name}.` : `Rule updated — ${value} files as ${c.name}.`);
        return () => patchRules((prev) => prev.map((r) => (r.id === id ? before : r)));
      },
      send: () => apiUpdateRule(id, write
        ? { conditions: write.conditions, logic: write.logic, categoryId, budgetExcluded, spread }
        : { value, categoryId, field: before.field, operator: before.operator, budgetExcluded, spread }),
      onSaved: (saved) => {
        patchRules((prev) => prev.map((r) => (r.id === id ? { ...toRule(saved), isNew: r.isNew } : r)));
        refreshAfterApplyRules({ skipRules: true });
      },
      onFailed: (e) => showToast(ruleWriteErrorMessage(e, 'Could not update rule. Please try again.', spread)),
      whenSignedOut: undefined,
    });
  }, [showToast, patchRules, refreshAfterApplyRules, runSave]);

  // Save a goal — one method for create AND edit (an upsert, mirroring the server). A
  // create mints a client id (Crypto.randomUUID) and APPENDS; an edit (editId set) REPLACES
  // that id in place. Optimistic-then-rollback like the rule writers: the ['goals'] cache the
  // hub reads updates instantly, then the server row swaps in on success — or the change is
  // undone and a toast shown on failure. `body` carries exactly one balance source (the
  // GoalWriteBody union), so a synced/manual mix can't be built.
  const saveGoal = useCallback(async (editId: string | null, body: GoalWriteBody): Promise<boolean> => {
    const id = editId ?? Crypto.randomUUID();
    // Snapshot the pre-edit record (for the rollback) from the ['goals'] query cache the hub
    // reads, not a store useState — same source-of-truth choice as the rule writers (WHIT-192).
    const before = queryClient.getQueryData<GoalRecord[]>(goalsKey)?.find((g) => g.id === id) ?? null;
    // Checkpoints need their permanent ids BEFORE the optimistic row lands in the cache: a
    // GoalRecord promises every checkpoint has one, and the celebration keys on it. Mint any
    // missing id here (like the goal id above) and send the SAME ids on, so the optimistic row
    // and the saved row can't disagree. The server still mints for a body that omits them.
    const checkpoints = body.checkpoints?.map((cp) => ({ ...cp, id: cp.id ?? Crypto.randomUUID() }));
    const optimistic: GoalRecord = { id, ...body, checkpoints };
    // WHIT-271: on sign-out mid-flight runSave runs neither the success swap NOR the rollback —
    // both use `prev ?? []`, so on the cleared cache they'd SEED a stale/empty goals list into
    // the next session. It returns false so the edit form's router.back() doesn't fire post-redirect.
    return runSave({
      apply: () => {
        // Upsert into the cache: replace the id in place if present, else append.
        queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => {
          const list = prev ?? [];
          const at = list.findIndex((g) => g.id === id);
          if (at >= 0) { const next = [...list]; next[at] = optimistic; return next; }
          return [...list, optimistic];
        });
        // Roll back: restore the prior record for an edit, or drop the appended one for a create.
        return () => queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => {
          const list = prev ?? [];
          return before ? list.map((g) => (g.id === id ? before : g)) : list.filter((g) => g.id !== id);
        });
      },
      send: () => apiSaveGoal(id, { ...body, checkpoints }),
      onSaved: (saved) => {
        // Swap the optimistic row for the server's authoritative one (same id).
        queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) =>
          (prev ?? []).map((g) => (g.id === id ? saved : g)));
        return true;
      },
      onFailed: () => {
        showToast('Could not save goal. Please try again.');
        return false;
      },
      whenSignedOut: false,
    });
  }, [showToast, runSave]);

  // Delete a goal. Optimistically remove it from the ['goals'] cache, then DELETE server-side;
  // on failure put it back in front of the row that followed it (WHIT-254 — a saved index
  // would misplace it when two deletes fail at once) and warn. The server DELETE is idempotent
  // (unknown id → 200), so a rollback that races a refresh can't wedge. Unlike deleteRule
  // (whose patchRules no-ops on an evicted cache), this resurrects the row via `prev ?? []`.
  const deleteGoal = useCallback(async (id: string): Promise<boolean> => {
    const current = queryClient.getQueryData<GoalRecord[]>(goalsKey) ?? [];
    const index = current.findIndex((g) => g.id === id);
    if (index === -1) return false;
    const removed = current[index];
    const successorIds = current.slice(index + 1).map((g) => g.id);
    // WHIT-271: runSave skips the undo after sign-out, so the removed goal is never resurrected
    // (via `prev ?? []`) into the cleared cache, and returns false so the form's router.back()
    // doesn't fire.
    return runSave({
      apply: () => {
        queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => (prev ?? []).filter((g) => g.id !== id));
        return () => queryClient.setQueryData<GoalRecord[]>(goalsKey, (prev) => reinsertBefore(prev ?? [], removed, successorIds));
      },
      send: () => apiDeleteGoal(id),
      onSaved: () => true,
      onFailed: () => {
        showToast('Could not delete goal. Please try again.');
        return false;
      },
      whenSignedOut: false,
    });
  }, [showToast, runSave]);

  const value = useMemo<AppContext>(() => ({
    alerts,
    sheet, toast,
    pendingUncategorizedSelect,
    setSheet, readSheetDraft, writeSheetDraft, getSessionEpoch, showToast,
    requestUncategorizedSelect, clearUncategorizedSelect,
    toggleAlerts: () => setAlerts((a) => !a),
    setPayCycleLength, setPayday,
    openPicker, openMultiPicker, openGoalBalance, chooseCategory, applyCategory, applyCategoryToMany, previewFiling, fileCharges, retryApplyRulesJob, applyRulesJob, applyRulesStalled, applyTransactionEdit, deleteTransaction, saveBudget, deleteBudget, saveSpread, removeSpread, saveCategory, createCategoryInline, deleteCategory, deleteRule, saveManualRule, updateRule, saveGoal, deleteGoal, saveLoanFacts, saveMilestones,
    aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights,
  }), [alerts, sheet, toast, pendingUncategorizedSelect, readSheetDraft, writeSheetDraft, getSessionEpoch, showToast, requestUncategorizedSelect, clearUncategorizedSelect, setPayCycleLength, setPayday, openPicker, openMultiPicker, openGoalBalance, chooseCategory, applyCategory, applyCategoryToMany, previewFiling, fileCharges, retryApplyRulesJob, applyRulesJob, applyRulesStalled, applyTransactionEdit, deleteTransaction, saveBudget, deleteBudget, saveSpread, removeSpread, saveCategory, createCategoryInline, deleteCategory, deleteRule, saveManualRule, updateRule, saveGoal, deleteGoal, saveLoanFacts, saveMilestones, aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppContext(): AppContext {
  const s = useContext(Ctx);
  if (!s) throw new Error('useAppContext must be used within AppProvider');
  return s;
}

// ---------------------------------------------------------------------------
// Derived-value selectors (ported from renderVals). Pure functions over state.
// ---------------------------------------------------------------------------

// (cycleWindow was removed in WHIT-342: the category drill-in now fetches its window
// server-side, and it was the last caller — the server owns the cycle window.)

// --- Goals: balance-target progress + pace (WHIT-232) ----------------------
// The pure math behind a goal card: how full the thermometer is (progress) and how much
// to move each payday to hit the target date (pace), for BOTH directions — grow (savings,
// balance should RISE to target) and paydown (debt, balance should FALL to target, usually
// 0). No formatting, no fetch, no render: the fetch layer (WHIT-233) resolves the balance
// and feeds this; the screen (WHIT-234) formats the numbers.
export type BalanceGoalDirection = 'grow' | 'paydown';
export type BalanceGoalStatus = 'ahead' | 'on_track' | 'behind';

// The subset of the WHIT-231 server goal record this selector reads. `account_id` present
// => a SYNCED source (current balance is the live signed `balance` input); otherwise
// `manual_balance` present => a MANUAL source (and is itself the current balance). For a
// paydown goal `baseline` doubles as the starting balance the % is measured down from.
export interface BalanceGoal {
  direction: BalanceGoalDirection;
  target_amount: number;          // >= 0; grow guarantees > 0 server-side
  target_date: string;            // ISO YYYY-MM-DD
  baseline?: number | null;       // optional "count from £X"
  account_id?: string | null;     // present => synced source
  manual_balance?: number | null; // present => manual source (and the current balance)
  manual_as_of?: string | null;
  // WHIT-252: the immutable start (date + balance when the goal began). Server-stamped; the
  // deferred ahead/behind card reads these to draw expected pace. `status` stays null until then.
  start_date?: string | null;
  start_balance?: number | null;
  // WHIT-478: the checkpoint ladder (absolute amounts). Only the amount is needed to count how
  // many the current balance has passed; the labels/ids belong to the editor, not this selector.
  checkpoints?: { amount: number }[] | null;
}

export interface BalanceGoalInput {
  goal: BalanceGoal;
  // Live SIGNED balance for a SYNCED goal (AccountBalance.amount: spending +, loan/credit −);
  // null = not yet polled. Ignored for a manual goal (its balance is on the record).
  balance: number | null;
  payCycle: { length: number; last_pay_date: string };
}

export interface BalanceGoalView {
  progress: number | null;        // 0..1, or null when the % can't be computed safely
  pacePerPayday: number | null;   // amount to move each payday, or null when the balance is unknown
  paydaysLeft: number;            // >= 0
  // WHIT-262: ahead / on-track / behind when the goal has an immutable start (date + balance);
  // null when it can't be judged — no start yet, unknown balance, or a degenerate span. Anchored
  // on start_balance, NOT the display baseline, so the progress bar and this label can measure
  // from slightly different starting points by design.
  status: BalanceGoalStatus | null;
  // WHIT-478: how many checkpoints the current balance has passed, out of how many. `total` is 0
  // when the goal has no ladder (the card renders nothing). `reached` is null when the balance
  // isn't known yet (a synced goal not yet polled — degrade like the rest of the card).
  checkpointsTotal: number;
  checkpointsReached: number | null;
  // WHIT-486: one dot per checkpoint — `pct` is its position on the bar (0..1, same scale as
  // `progress`), `reached` whether the balance has passed it. Empty when the balance is unknown or
  // the bar has no scale (paydown without a start), so dots and the reached-count travel together.
  checkpointMarkers: { pct: number; reached: boolean }[];
}

// Count the paydays remaining before a target date: the payday dates `last_pay_date +
// n*length` that fall in the half-open window (today, target] — strictly after today, on or
// before target. Whole-day UTC math via the shared dateutil helpers (also used by cycleClock)
// so a Melbourne daylight-saving change can't shift the count. The count of integers n with
// today < pay + n*len <= target is floor(dTarget/len) − floor(dToday/len); floor handles a
// last_pay_date in the future (n<0).
export function paydaysUntil(
  payCycle: { length: number; last_pay_date: string },
  targetISO: string,
  today?: Date,
): number {
  const len = payCycle.length;
  if (!(len > 0)) return 0;
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  const target = isoToUtcDayMs(targetISO);
  const now = today ?? new Date();
  const dToday = wholeDaysBetween(pay, dateToUtcDayMs(now));
  const dTarget = wholeDaysBetween(pay, target);
  if (Number.isNaN(dTarget) || Number.isNaN(dToday)) return 0; // this selector's contract: bad date -> 0
  return Math.max(0, Math.floor(dTarget / len) - Math.floor(dToday / len));
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Source-aware normalise into a non-negative quantity — used for BOTH the current and the
// start balance so they're always measured the same way:
//  grow    -> savings amount; an overdrawn synced account (−50) clamps to 0, never abs.
//  paydown -> amount OWED as a positive: synced owed = max(0, −value) (loan stored negative);
//             a manual debt is entered positive so owed = max(0, value). A credit clamps to 0.
function normaliseBalance(value: number, direction: BalanceGoalDirection, synced: boolean): number {
  return direction === 'grow' ? Math.max(0, value) : Math.max(0, synced ? -value : value);
}

// WHIT-262: a goal within this many percentage-points (0.05 = 5pp) of its straight-line expected
// fill reads "on track"; beyond it, ahead/behind. An absolute band (not a ratio) so it stays
// stable near the start, where the expected fill is ≈ 0 and a ratio would blow up.
export const GOAL_PACE_TOLERANCE = 0.05;

// WHIT-262: ahead / on-track / behind, by comparing the ACTUAL fill from the immutable start
// against the straight-line EXPECTED fill at today. `currentN` is the already-normalised current
// balance. Returns null (no honest label) when: no persisted start, the start isn't above the
// target (nothing to measure), or the start→target span is zero/negative/unparseable.
function goalPaceStatus(
  goal: BalanceGoal,
  currentN: number,
  today: Date | undefined,
): BalanceGoalStatus | null {
  if (goal.start_date == null || goal.start_balance == null || !Number.isFinite(goal.start_balance)) {
    return null;
  }
  const synced = !!goal.account_id;
  const startN = normaliseBalance(goal.start_balance, goal.direction, synced);

  // Actual fill measured from the START anchor (distinct from `progress`, which counts from
  // baseline). Guard the denominator: a start already at/past the target has nothing to measure.
  const actualDenom = goal.direction === 'grow' ? goal.target_amount - startN : startN - goal.target_amount;
  if (!(actualDenom > 0)) return null;
  const actualFrac = clamp01(
    goal.direction === 'grow'
      ? (currentN - startN) / actualDenom
      : (startN - currentN) / actualDenom,
  );

  // Expected straight-line fill: elapsed days / total days (start_date → target_date). `!(x > 0)`
  // rejects a zero/negative span AND a NaN from an unparseable date (NaN <= 0 is false).
  const startMs = isoToUtcDayMs(goal.start_date);
  const totalDays = wholeDaysBetween(startMs, isoToUtcDayMs(goal.target_date));
  if (!(totalDays > 0)) return null;
  const expectedFrac = clamp01(wholeDaysBetween(startMs, dateToUtcDayMs(today ?? new Date())) / totalDays);

  if (actualFrac >= expectedFrac + GOAL_PACE_TOLERANCE) return 'ahead';
  if (actualFrac <= expectedFrac - GOAL_PACE_TOLERANCE) return 'behind';
  return 'on_track';
}

// The goal engine. Pure over its inputs. Progress, pace, and status are correct for both
// directions (see BalanceGoalView for what status measures).
export function balanceGoalView(s: BalanceGoalInput, today?: Date): BalanceGoalView {
  const { goal } = s;
  const target = goal.target_amount;
  const baseline = goal.baseline ?? null;
  const synced = !!goal.account_id;

  // The current balance: a synced goal's live SIGNED input, else the manual record value.
  const raw = synced ? s.balance : (goal.manual_balance ?? null);
  const bal: number | null = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const known = bal !== null;

  // Normalise into a non-negative quantity, source-aware (see normaliseBalance).
  let current = 0;
  if (bal !== null) {
    current = normaliseBalance(bal, goal.direction, synced);
  }

  const paydaysLeft = paydaysUntil(s.payCycle, goal.target_date, today);

  // The bar's SCALE — the 0% anchor + the span the fill AND the WHIT-486 checkpoint dots both
  // measure against, so a dot always lands exactly where the fill reaches. `barSpan > 0` means the
  // bar is positionable: grow with the target above the count-from; paydown with a start owed above
  // the target. A paydown goal with no start has no scale (owed/target shown instead of a bar).
  let barLo = 0;
  let barSpan = 0;
  if (goal.direction === 'grow') {
    barLo = baseline ?? 0;
    barSpan = target - barLo;
  } else if (baseline != null) {
    barLo = baseline;
    barSpan = baseline - target;
  }
  const barPositionable = barSpan > 0;

  // One reached-test and one bar-position, shared by the fill, the reached-count AND the dots — so
  // "a dot sits on the fill edge" and "filled-dot count == reached-count" hold by construction, not
  // by keeping copied formulas in sync. `posOnBar` measures any absolute amount on the bar's scale.
  const isReached = (amount: number) =>
    goal.direction === 'grow' ? current >= amount : current <= amount;
  const posOnBar = (amount: number) =>
    clamp01(goal.direction === 'grow' ? (amount - barLo) / barSpan : (barLo - amount) / barSpan);

  // Progress % (0..1). Guarded — a clamp can't rescue 0/0 = NaN. grow fills up from barLo; paydown
  // fills as the owed amount falls from barLo toward the target.
  const progress: number | null = known && barPositionable ? posOnBar(current) : null;

  // Per-payday pace: remaining (floored at 0 so a met goal is 0, never negative) over the
  // paydays left. 0 paydays left (overdue / before the next payday) -> the whole amount now.
  let pacePerPayday: number | null = null;
  if (known) {
    const remaining = goal.direction === 'grow'
      ? Math.max(0, target - current)
      : Math.max(0, current - target);
    pacePerPayday = paydaysLeft > 0 ? remaining / paydaysLeft : remaining;
  }

  // Status only when the balance is known; goalPaceStatus guards the rest (no start, span, etc).
  const status = known ? goalPaceStatus(goal, current, today) : null;

  // Checkpoints reached (WHIT-478): count the absolute amounts the CURRENT normalised balance has
  // passed — grow reaches AT/above the amount, paydown AT/below. Uses `current`, the same balance
  // the bar measures, so the count can never disagree with the bar. `reached` stays null while the
  // balance is unknown so the card hides the line; `total` is 0 when there's no ladder.
  const checkpoints = goal.checkpoints ?? [];
  const checkpointsTotal = checkpoints.length;
  let checkpointsReached: number | null = null;
  if (known && checkpointsTotal > 0) {
    checkpointsReached = checkpoints.filter((cp) => isReached(cp.amount)).length;
  }

  // WHIT-486: each checkpoint's dot — its position on the bar (0..1, the SAME scale as `progress`,
  // so a dot lines up with the fill by construction) and whether the balance has reached it (the
  // SAME test as the count above). Empty until the balance is known AND the bar is positionable, so
  // the dots and the "N of M reached" line always appear together — never a count with no dots.
  let checkpointMarkers: { pct: number; reached: boolean }[] = [];
  if (known && barPositionable && checkpointsTotal > 0) {
    checkpointMarkers = checkpoints.map((cp) => ({ pct: posOnBar(cp.amount), reached: isReached(cp.amount) }));
  }

  return { progress, pacePerPayday, paydaysLeft, status, checkpointsTotal, checkpointsReached, checkpointMarkers };
}

// Under-budget and income bars share one calm fill; rose (C.bad) means over (WHIT-729).
const BAR_FILL = C.accentSoft;

export interface BudgetView {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spentLabel: string; remainAmount: string; remainLabel: string; remainColor: string;
  postedPct: number; pendingPct: number; targetPct: number; postedColor: string;
  pendingTint: string; over: boolean;
  // WHIT-728: a muted line saying why this cycle's budget differs from the target (spread or rollover), else ''.
  note: string;
  // Sub-category tree (WHIT-221): `depth` is the indent level — the number of the
  // row's ancestors that are ALSO budgeted rows (0 = top-level or a sub whose parent
  // isn't budgeted). `parentId` is the nearest budgeted ancestor's id (the row it
  // nests under), or null at the top level.
  depth: number; parentId: string | null;
  // WHIT-707: Spending rows list before Earning rows; income hides the today marker.
  section: 'spending' | 'earning'; showTarget: boolean;
  // WHIT-727: true only for a spend row past its pace line but not over.
  behindPace: boolean;
  // WHIT-730: a spend row with nothing spent yet (and not over), drawn slim without a bar.
  unspent: boolean;
}

// The exact slice budgetViews reads. A narrow input (not the whole AppContext) so a
// caller feeding it query data — not the store — is type-checked field-by-field instead
// of silently casting (WHIT-188). WHIT-192: the store no longer carries these fields, so
// the selector logic tests feed a plain fixture (see __tests__/factory.makeState) that
// satisfies this shape structurally.
export interface BudgetViewsInput {
  budgets: Budget[];
  category: (id: string) => Category | undefined;
  cycleLen: number;
  daysLeft: number;
  nextPayday?: string; // ISO "YYYY-MM-DD"; income rows read "next pay ~Fri" when set
}

// "today" / "~Fri" (within 6 days) / "~17 Oct" (further out, where a weekday is ambiguous).
function nextPayLabel(nextPayday: string, daysLeft: number): string {
  if (daysLeft <= 0) return 'today';
  if (daysLeft <= 6) return `~${formatWeekdayShort(nextPayday)}`;
  return `~${formatDayMonth(nextPayday)}`;
}

// The rollover buffer in one sentence, shared by the Budgets row note and the detail screen.
function carryoverNote(b: Pick<Budget, 'rollover' | 'carryover'>): string {
  if (!b.rollover) return '';
  if (b.carryover < -0.5) return `Includes ${fmt(b.carryover)} past overspend`;
  if (b.carryover > 0.5) return `Includes ${fmt(b.carryover)} past leftovers`;
  return '';
}

export function budgetViews(s: BudgetViewsInput): { rows: BudgetView[]; totBudget: number; totSpent: number; totPending: number; totRemain: number } {
  const elapsed = elapsedFrac(s);
  let totBudget = 0, totSpent = 0, totPending = 0, totRemain = 0;

  // Pass 1: which budgeted categories produce a row (everything but Savings, which is
  // skipped entirely). Needed up front so the tree walk below can tell whether a row's
  // ancestor is itself budgeted BEFORE we start emitting — a single pass would miss a
  // parent that sorts after its child and under-de-dup the hero total (WHIT-221).
  const budgetedRowIds = new Set<string>();
  for (const b of s.budgets) {
    const c = s.category(b.id);
    if (c && c.bucket !== 'Savings') budgetedRowIds.add(b.id);
  }

  // The nearest ancestor that is itself a budgeted row (the row this one nests under),
  // and how many budgeted ancestors it has (its indent depth). Both walk the category
  // `parent` chain and are guarded against a missing parent and a corrupt cycle.
  const walkBudgetedAncestors = (c: Category): { nearest: string | null; depth: number } => {
    let nearest: string | null = null, depth = 0;
    const seen = new Set<string>();
    let pid = c.parent ?? null;
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      const parent = s.category(pid);
      // Only a SAME-BUCKET budgeted ancestor nests/de-dups this row. The server's
      // same-bucket rule keeps a family single-bucket, so this is a no-op for clean
      // data — but it hardens the hero math against a corrupt cross-bucket link (e.g.
      // a legacy re-bucket) that would otherwise silently drop a spend sub from the
      // total instead of counting it once on its own.
      if (budgetedRowIds.has(pid) && parent && parent.bucket === c.bucket) {
        if (nearest === null) nearest = pid;
        depth++;
      }
      pid = parent ? (parent.parent ?? null) : null;
    }
    return { nearest, depth };
  };

  // Pass 2: build each row's view keyed by id, group by nearest budgeted ancestor, and
  // accumulate the hero totals — spend rows ONLY, and ONLY the top-most budgeted row in
  // each family (depth 0). The server already rolled a parent's spend over its descendant
  // leaves, so counting only the top row counts every transaction exactly once.
  const viewById = new Map<string, BudgetView>();
  const childrenByParent = new Map<string | null, string[]>();
  const group = (parentId: string | null, id: string) => {
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(id); else childrenByParent.set(parentId, [id]);
  };

  for (const b of s.budgets) {
    const c = s.category(b.id);
    if (!c) continue;
    // Savings-bucket budgets have no meaningful rollup — savings for this app is an
    // account balance, not categorised transactions, so a Savings target would render
    // a permanently-empty spend bar. Skip it entirely (row AND totals) until a real
    // account-balance goal exists (WHIT-201). New Savings budgets are already blocked
    // in app/budget/pick.tsx; this also hides one set before that or via re-bucketing.
    if (c.bucket === 'Savings') continue;
    const { nearest: parentId, depth } = walkBudgetedAncestors(c);
    // posted/pending come from the server rollup (computed over the window). For an
    // Income category the rollup is positive EARNINGS, not spend.
    const pending = b.pending, posted = b.posted, actual = posted + pending;
    // Rollover: this cycle's spendable is the target PLUS the accumulated buffer (a sinking
    // fund adds room; a prior spike's deficit removes it). A bill spread adds its own signed
    // adjustment (a cushion this cycle, a slice in a payback cycle). Rollover XOR spread, so
    // at most one term is non-zero; Non-rollover/non-spend/Income => both 0, available == budget.
    const available = availableToSpend(b);
    // Bars/remain divide by `available`, but it can be 0 or negative (a drained/borrowed
    // envelope) — fall back to the base target, then 1, so a percentage is never NaN.
    const den = available > 0 ? available : (b.budget > 0 ? b.budget : 1);
    // Pace stays on the base per-cycle target: "should I have spent this much of THIS
    // cycle's plan by now" — the buffer isn't part of the cycle's pace.
    const target = paceTarget(b, s);
    const postedPct = Math.max(0, Math.min(100, (posted / den) * 100));

    if (c.bucket === 'Income') {
      // Earn-target (floor): over-is-good, so the direction and colours invert —
      // never red, being under target early in the cycle is calm, not alarming.
      // Income rows are kept OUT of the spend hero totals (a floor is a different
      // unit from a spend ceiling), but still listed. `over` stays false so nothing
      // downstream flips the row red.
      // Salary lands in one lump, so an even daily pace means nothing here (WHIT-707): no pace
      // line, no today marker — just what's earned and when the next pay is due.
      const met = actual >= b.budget;
      const pendingPct = Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
      let spentLabel = `${fmtExact(actual)} earned`;
      if (s.nextPayday) spentLabel += ` · next pay ${nextPayLabel(s.nextPayday, s.daysLeft)}`;
      viewById.set(b.id, {
        id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
        spentLabel,
        remainAmount: fmtExact(met ? actual - b.budget : b.budget - actual),
        remainLabel: met ? 'above target' : 'to go',
        remainColor: C.good,
        postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: BAR_FILL,
        pendingTint: tint(BAR_FILL, 0.45), over: false,
        note: '', depth, parentId,
        section: 'earning', showTarget: false, behindPace: false, unspent: false,
      });
      group(parentId, b.id);
      continue;
    }

    // Spend budget (ceiling): under-is-good, over is red. With rollover, the ceiling is the
    // AVAILABLE envelope (target + buffer), so drawing down a sinking fund reads calm, not
    // red; the hero totals count `available` too so the top number matches the rows.
    const spent = actual, remain = available - spent;
    // De-dup the hero totals: count only the TOP-MOST budgeted spend row per family
    // (depth 0). A budgeted sub is already inside its parent's rolled-up spend, so
    // adding it again would double-count (WHIT-221). Same-bucket means a spend row's
    // budgeted ancestors are all spend, so depth 0 == no budgeted spend ancestor.
    if (depth === 0) { totBudget += available; totSpent += spent; totPending += pending; totRemain += remain; }
    const over = spent > available;
    const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / den) * 100, 100 - postedPct));
    // Spending too fast (WHIT-712). The row shows no pace line (WHIT-744) and the list no longer ranks on it (WHIT-745).
    const behindPace = paceWarning({ spent, target, available, over }, s);
    // "of" shows the exact AVAILABLE envelope so it reconciles with the remaining amount (available −
    // spent); a no-break space keeps "of" with its amount. `spent` includes pending; the bar shows it as the lighter segment.
    const spentLabel = `${fmtExact(spent)} of ${fmtSignedExact(available)}`;
    let note = carryoverNote(b);
    if (b.spread && Math.abs(b.spreadAdjustment) > 0.005) note = 'Includes spread bills';
    const unspent = !over && spent < 0.005;
    viewById.set(b.id, {
      id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
      spentLabel, remainAmount: fmtExact(remain), remainLabel: over ? 'over' : 'left', remainColor: over ? C.bad : C.good,
      postedPct, pendingPct, targetPct: pacePct(target, den), postedColor: over ? C.bad : BAR_FILL,
      pendingTint: tint(over ? C.bad : BAR_FILL, 0.45), over,
      note, depth, parentId,
      section: 'spending', showTarget: !over && remain > 0.005, behindPace, unspent,
    });
    group(parentId, b.id);
  }

  // Pass 3: emit depth-first — each row immediately followed by its budgeted
  // descendants — preserving the incoming sibling order within each group. `emitted`
  // guards against a corrupt parent cycle re-emitting a row; the trailing sweep emits
  // any row left unreachable from the top level so no budget is ever dropped.
  const rows: BudgetView[] = [];
  const emitted = new Set<string>();
  const emit = (id: string) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const view = viewById.get(id);
    if (view) rows.push(view);
    for (const childId of childrenByParent.get(id) ?? []) emit(childId);
  };
  for (const id of childrenByParent.get(null) ?? []) emit(id);
  for (const id of viewById.keys()) emit(id);

  // Spending before Earning (WHIT-707). Families are single-bucket, so each sub stays after its parent.
  const ordered = [...rows.filter((r) => r.section === 'spending'), ...rows.filter((r) => r.section === 'earning')];
  return { rows: ordered, totBudget, totSpent, totPending, totRemain };
}

// Which categories may be chosen as the parent of the category being edited (WHIT-221):
// same bucket (the server enforces same-bucket parent/child), never itself, and never
// one of its own descendants (that would make a cycle). For a NEW category (editId null)
// there are no descendants, so every same-bucket category is eligible. Pure + exported
// so the category-edit picker and its tests share one rule.
export function eligibleParents(categories: Category[], editId: string | null, bucket: Bucket): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const isDescendantOfEdit = (c: Category): boolean => {
    if (!editId) return false;
    const seen = new Set<string>();
    let pid = c.parent ?? null;
    while (pid && !seen.has(pid)) {
      if (pid === editId) return true;
      seen.add(pid);
      pid = byId.get(pid)?.parent ?? null;
    }
    return false;
  };
  return categories.filter((c) => c.bucket === bucket && c.id !== editId && !isDescendantOfEdit(c));
}

// Client mirror of the server's category nesting cap (shared/repository_category.py
// _MAX_CATEGORY_DEPTH, WHIT-223). Advisory only — the server re-validates on write, so if the
// two ever drift the server wins (a too-deep attach is rejected with a toast).
export const MAX_CATEGORY_DEPTH = 5;

// Client mirror of the server's per-parent sub-category cap (shared/repository_category.py
// _MAX_CHILDREN_PER_CATEGORY). Advisory like MAX_CATEGORY_DEPTH — the server re-validates on
// write and wins if the two ever drift. Used to grey out a full parent in the picker (WHIT-441)
// before the user tries an attach the server would refuse.
export const MAX_CHILDREN_PER_CATEGORY = 50;

// How many categories are nested directly under `parentId`. The client mirror of the count the
// server caps at MAX_CHILDREN_PER_CATEGORY, so the picker can tell a full parent from a spare one.
export function childCount(categories: Category[], parentId: string): number {
  return categories.reduce((total, c) => (c.parent === parentId ? total + 1 : total), 0);
}

// The level of `id` in the tree: nodes from it up to and including its root (root = 1), or 0
// for null. Cycle-safe. Mirrors the server's _ancestor_depth.
function ancestorDepth(byId: Map<string, Category>, id: string | null): number {
  let depth = 0;
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) { seen.add(cur); depth++; cur = byId.get(cur)?.parent ?? null; }
  return depth;
}

// The level a category sits at given the id of its parent (a top-level node, parent null, is
// level 1). One source for "how deep am I" so the edit screen's depth gate and eligibleChildren
// can't drift from each other — or from the server's _ancestor_depth. Cycle-safe.
export function categoryDepth(categories: Category[], parentId: string | null): number {
  if (parentId === null) return 1;
  return ancestorDepth(new Map(categories.map((c) => [c.id, c])), parentId) + 1;
}

// The tallest downward chain from `id` in LEVELS (1 for a leaf), cycle-safe. Mirrors the
// server's _subtree_height. `childrenOf` maps a parent id to its child ids.
function subtreeHeight(childrenOf: Map<string, string[]>, id: string): number {
  const walk = (node: string, seen: Set<string>): number => {
    if (seen.has(node)) return 0;
    seen.add(node);
    const kids = childrenOf.get(node);
    if (!kids || kids.length === 0) return 1;
    return 1 + Math.max(...kids.map((k) => walk(k, seen)));
  };
  return walk(id, new Set());
}

// Which existing categories may be attached AS CHILDREN of the category being edited
// (WHIT-237), mirroring the three server rules: same bucket; never the category itself; never
// one of its ancestors (that would make a cycle); and the attach must not push the family past
// MAX_CATEGORY_DEPTH — depth(self) + height(candidate) <= 5. `selfId` is null for a not-yet-
// created parent; `selfParentId` is the parent this category itself rolls up into (so a nested
// parent counts its own depth). A candidate already parented to self is still returned so the
// picker can show it pre-selected. Pure + exported so the screen and its tests share one rule.
export function eligibleChildren(
  categories: Category[], selfId: string | null, selfParentId: string | null, bucket: Bucket,
): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const childrenOf = new Map<string, string[]>();
  for (const c of categories) {
    const p = c.parent ?? null;
    if (p) { const list = childrenOf.get(p); if (list) list.push(c.id); else childrenOf.set(p, [c.id]); }
  }
  // Where `self` sits (top-level = 1). A nested parent is deeper, so fewer descendants fit
  // under it before hitting the cap.
  const selfDepth = categoryDepth(categories, selfParentId);
  const isAncestorOfSelf = (candidateId: string): boolean => {
    const seen = new Set<string>();
    let cur = selfParentId;
    while (cur && !seen.has(cur)) { if (cur === candidateId) return true; seen.add(cur); cur = byId.get(cur)?.parent ?? null; }
    return false;
  };
  return categories.filter((c) =>
    c.bucket === bucket &&
    c.id !== selfId &&
    !isAncestorOfSelf(c.id) &&
    selfDepth + subtreeHeight(childrenOf, c.id) <= MAX_CATEGORY_DEPTH,
  );
}

// One row for the Insights "Earning" toggle (WHIT-373). Same shape the retired /breakdown earned
// branch built: each Income-bucket source that earned this cycle, joined to the taxonomy for its
// name/icon/colour. `amount` is the signed net (posted + pending) — negative for a source clawed
// back this cycle (`reversed`). `muted` marks the synthetic reconcile plug: not a real source, no
// drill. `drillId` is the id a tap opens (the source's transactions).
export interface IncomeBreakdownRow {
  id: string; name: string; color: string; icon: string; chipBg: string;
  amount: number; pending: number; reversed: boolean; muted: boolean; drillId: string;
}

export interface IncomeBreakdownInput {
  incomeSources: { id: string; posted: number; pending: number; amount: number }[];
  earned: number;
  category: (id: string) => Category | undefined;
}

const INCOME_FALLBACK_ICON = 'briefcase';

// Income by source for the Insights "Earning" toggle (WHIT-373). Pure over { incomeSources, earned,
// category }, ported from the retired /breakdown earned branch so the rows still reconcile to the
// `earned` headline. A source clawed back this cycle rides a NEGATIVE net (rendered "−$X"); one
// muted "adjustment" plug closes any residual between the shown sources and `earned` (mirrors the
// Spend remainder line). The plug is skipped when there are no sources (an old server with no
// per-source map never shows a lone plug) or when the residual is float dust.
export function incomeBreakdown(s: IncomeBreakdownInput): { rows: IncomeBreakdownRow[] } {
  const rows: IncomeBreakdownRow[] = s.incomeSources.map((source) => {
    const c = s.category(source.id);
    const color = c?.color ?? C.good;
    return {
      id: source.id,
      name: c?.name ?? 'Income',
      color,
      icon: c?.icon ?? INCOME_FALLBACK_ICON,
      chipBg: tint(color, 0.15),
      amount: source.amount,
      pending: source.pending,
      reversed: source.amount < 0,  // a source clawed back this cycle — shown as "−$X"
      muted: false,
      drillId: source.id,
    };
  });

  // `earned` clamps its settled and pending buckets separately while the sources are raw signed
  // nets, so the two can differ by a clamped-away residual. One muted plug closes the gap.
  const shownAmount = rows.reduce((sum, row) => sum + row.amount, 0);
  const residual = s.earned - shownAmount;
  if (rows.length > 0 && Math.abs(residual) >= RECONCILE_EPSILON) {
    rows.push({ id: '__earned_adjustment__', ...ADJUSTMENT_ROW, amount: residual, pending: 0, reversed: false, muted: true, drillId: '__earned_adjustment__' });
  }

  return { rows };
}

export interface CategoryBreakdownRow {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spent: number; posted: number; pending: number;
  spentLabel: string; pct: number; uncategorized: boolean;
  // Sub-category drill-down (WHIT-226): `depth` is the indent level (0 = top-level);
  // `parentId` is the row this nests under (null at top level); `hasChildren` flags an
  // expandable parent. A parent row's spent/posted/pending are the COMBINED subtree
  // totals. `spent` still drives the bar, so the flat-taxonomy path is unchanged.
  depth: number; parentId: string | null; hasChildren: boolean;
  // WHIT-308: the id a tap on this row drills into. Same as `id` for a normal leaf and the
  // Uncategorized row, but a synthetic "Directly in X" row drills into its PARENT id (that's
  // whose direct spend the row shows), so the drill filter is a clean `t.category === drillId`
  // with no id string-parsing. Unused on parent rows (they expand, they don't drill).
  drillId: string;
  // WHIT-349: a display-only "refund" line under an expanded parent for a net-refunded member
  // hidden from the flat rows. `spent` is NEGATIVE; never a donut slice, never in the hero total.
  isRefund?: boolean;
  // WHIT-357: a synthetic "Other" line that plugs the residual between a parent's node and the
  // sum of its visible children, so the expanded list always sums to the node. `spent` can be
  // + or −; like a refund line it is never a donut slice, never in the hero, and not tappable.
  isRemainder?: boolean;
}

// The exact slice categoryBreakdown reads. A narrow input (not the whole AppContext) so
// the Insights screen can feed it query data — type-checked field-by-field, not cast
// (WHIT-189, mirrors BudgetViewsInput). WHIT-192: the selector logic tests feed a plain
// fixture (factory.makeState) that satisfies this shape structurally.
export interface CategoryBreakdownInput {
  breakdown: Record<string, CategorySpend>;
  category: (id: string) => Category | undefined;
}

// Spend by category for the current cycle (the Insights tab), as a parent→sub TREE
// (WHIT-226): a parent shows the COMBINED spend of everything under it and is expandable
// into its subs; the cycle total counts each transaction ONCE (a parent OR its subs,
// never both), mirroring the Budgets tree/hero de-dup. Pure over { breakdown, category }.
// A flat taxonomy (no parents) is byte-identical to the old per-leaf list: every row is
// depth 0 with no children, sorted highest-first.
export function categoryBreakdown(s: CategoryBreakdownInput): { rows: CategoryBreakdownRow[]; total: number } {
  // The server-owned netted parent roll-up: `nodes[id]` is a parent's netted subtree spend
  // (== its /budgets bar), `refunds[parent]` the hidden net-refunded members. Since WHIT-358 the
  // server ALWAYS emits __rollup__ (empty `{nodes:{}}` for a flat taxonomy or a no-spend window),
  // so a missing key now means only a cold `{}` cache before first fetch — defaulted to empty nodes
  // so it still renders flat (leaves read their floored flat value; total = the depth-0 sum).
  const rollup: BreakdownRollup = readRollup(s.breakdown) ?? { nodes: {} };
  const nodes = rollup.nodes;
  const ZERO = { posted: 0, pending: 0 };
  // Direct (own) spend per resolved id, from the server's per-category breakdown. `present` is
  // every real-category id in the breakdown INCLUDING net-refunded ones floored to {0,0} — under
  // the roll-up those still define the tree shape, so a parent whose only sub was refund-only this
  // cycle is still recognised as a parent (and reads its node, not its own floored spend — WHIT-349).
  const direct = new Map<string, { posted: number; pending: number }>();
  const present = new Set<string>();
  let uncategorized: { posted: number; pending: number } | null = null;
  for (const [id, spend] of Object.entries(s.breakdown)) {
    if (id === ROLLUP_KEY || id === EARNED_KEY || id === INCOME_KEY) continue;  // sentinels, not spend rows (WHIT-312/349/366)
    if (id === UNCATEGORIZED_KEY) {
      if (spend.posted + spend.pending > 0) uncategorized = { posted: spend.posted, pending: spend.pending };
      continue;
    }
    if (!s.category(id)) continue;  // a real id the taxonomy doesn't know — skip defensively
    present.add(id);
    if (spend.posted + spend.pending > 0) direct.set(id, { posted: spend.posted, pending: spend.pending });
  }

  // Row set: the tree-shape ids PLUS every taxonomy ancestor. Seed from `present` — every real
  // breakdown id, INCLUDING a net-refunded {0,0} sub — so a parent whose only sub was refund-only
  // this cycle is still recognised as a parent (reads its node, not its own floored spend). Cycle-guarded.
  const inRow = new Set<string>(present);
  for (const id of present) {
    const seen = new Set<string>();
    let pid = s.category(id)?.parent ?? null;
    while (pid && !seen.has(pid) && s.category(pid)) {
      seen.add(pid); inRow.add(pid);
      pid = s.category(pid)?.parent ?? null;
    }
  }

  // Nearest ancestor that is itself a row (what this nests under) + indent depth. Same
  // same-bucket + cycle guards as budgetViews, so a corrupt cross-bucket link counts the
  // row once on its own rather than mis-nesting it.
  const parentOf = new Map<string, string | null>();
  const depthOf = new Map<string, number>();
  const childIds = new Map<string, string[]>();
  for (const id of inRow) {
    const c = s.category(id)!;
    let nearest: string | null = null, depth = 0;
    const seen = new Set<string>();
    let pid = c.parent ?? null;
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      const p = s.category(pid);
      if (inRow.has(pid) && p && p.bucket === c.bucket) { if (nearest === null) nearest = pid; depth++; }
      pid = p ? (p.parent ?? null) : null;
    }
    parentOf.set(id, nearest); depthOf.set(id, depth);
    if (nearest !== null) { const k = childIds.get(nearest); if (k) k.push(id); else childIds.set(nearest, [id]); }
  }

  const mk = (id: string, name: string, color: string, icon: string, chipBg: string,
              posted: number, pending: number, depth: number, parentId: string | null,
              hasChildren: boolean, uncat: boolean, drillId: string): CategoryBreakdownRow => {
    const spent = posted + pending;
    return { id, name, color, icon, chipBg, spent, posted, pending,
      spentLabel: pending > 0 ? `${fmt(spent)} · ${fmt(pending)} pending` : fmt(spent),
      pct: 0, uncategorized: uncat, depth, parentId, hasChildren, drillId };
  };

  // Build every row (a parent carries its netted server node total; an absent node -> ZERO ->
  // dropped below), plus a synthetic "Directly in <name>" leaf under any parent that ALSO holds
  // its own directly-tagged spend. An expanded subtree reconciles to the parent node as: floored
  // children + "Directly in X" + refund line(s) == node (WHIT-349); the refund lines are appended
  // after this loop.
  const rowById = new Map<string, CategoryBreakdownRow>();
  const emitChildren = new Map<string | null, string[]>();
  const pushEmit = (p: string | null, id: string) => {
    const k = emitChildren.get(p); if (k) k.push(id); else emitChildren.set(p, [id]);
  };
  for (const id of inRow) {
    const c = s.category(id)!;
    const parentId = parentOf.get(id) ?? null;
    const depth = depthOf.get(id)!;
    const isParent = (childIds.get(id)?.length ?? 0) > 0;
    // WHIT-349: a PARENT reads its NETTED server node (== its /budgets bar); an absent node means
    // the subtree netted <= 0, so ZERO -> dropped below (matches Budgets), never the floored leaf
    // sum. A LEAF has no node -> its own floored spend. `nodes[id]` is a RUNTIME-missing guard
    // (noUncheckedIndexedAccess is off, so it types as present), hence `?? ZERO`.
    const comb = isParent ? (nodes[id] ?? ZERO) : (direct.get(id) ?? ZERO);
    // Drop a zero-combined row: an ancestor pulled in only to be skipped by the same-bucket
    // guard (a corrupt cross-bucket link), or a fully-refunded parent whose node is <= 0 (WHIT-349),
    // would otherwise render as a phantom $0 parent. A dropped parent's own positive floored child
    // then becomes a depth>=1 orphan (its parentId points at the absent parent): the screen never
    // reveals a child whose parent isn't shown, and the hero sums depth-0 only, so it stays hidden.
    if (comb.posted + comb.pending <= 0) continue;
    const kids = childIds.get(id) ?? [];
    const own = direct.get(id) ?? { posted: 0, pending: 0 };
    rowById.set(id, mk(id, c.name, c.color, c.icon, tint(c.color, 0.15),
      comb.posted, comb.pending, depth, parentId, kids.length > 0, false, id));
    pushEmit(parentId, id);
    if (kids.length > 0 && own.posted + own.pending > 0) {
      const dId = `${id}__direct`;
      // A "Directly in X" row shows the parent's OWN spend, so it drills into the parent id.
      rowById.set(dId, mk(dId, `Directly in ${c.name}`, c.color, c.icon, tint(c.color, 0.15),
        own.posted, own.pending, depth + 1, id, false, false, id));
      pushEmit(id, dId);
    }
  }
  if (uncategorized) {
    rowById.set(UNCATEGORIZED_KEY, mk(UNCATEGORIZED_KEY, 'Uncategorized', C.purple, 'q',
      'rgba(160,130,240,.16)', uncategorized.posted, uncategorized.pending, 0, null, false, true, UNCATEGORIZED_KEY));
    pushEmit(null, UNCATEGORIZED_KEY);
  }

  // WHIT-349: a display-only "refund" line under each surviving parent for its hidden net-
  // refunded members, so an expanded parent's visible rows (floored children + "Directly in X"
  // + refund lines) sum to its netted node. `spent` is negative; excluded from the donut + hero.
  if (rollup.refunds) {
    for (const [parentId, lines] of Object.entries(rollup.refunds)) {
      if (!rowById.has(parentId)) continue;  // parent didn't render — nothing to attach to
      const parentDepth = rowById.get(parentId)!.depth;
      for (const line of lines) {
        const rc = s.category(line.id);
        const color = rc?.color ?? C.purple;
        const rId = `${line.id}__refund`;
        rowById.set(rId, {
          id: rId, name: rc?.name ?? 'Refund', color, icon: rc?.icon ?? 'q', chipBg: tint(color, 0.15),
          spent: line.amount, posted: line.amount, pending: 0,
          spentLabel: `refund ${fmt(line.amount)}`, pct: 0, uncategorized: false,
          depth: parentDepth + 1, parentId, hasChildren: false, drillId: line.id, isRefund: true,
        });
        pushEmit(parentId, rId);
      }
    }
  }

  // WHIT-357: guarantee the expanded child list always sums to its parent node. `fold_subtree`
  // floors posted and pending INDEPENDENTLY, but a refund line reports a member's COMBINED signed
  // net, so in a rare posted-vs-pending sign split the visible rows can under- or over-sum the node
  // (the clamped remainder, or a dropped net-negative mid-parent). Plug the residual with one
  // synthetic "Other" line per parent — display-only like a refund line: no donut slice, never in
  // the hero, not tappable. Node values are fixed, so this reconciles level by level: each child
  // (itself a parent or a leaf) contributes its own already-reconciled node.
  for (const parentId of [...emitChildren.keys()]) {
    if (parentId === null) continue;  // top level reconciles via the hero total, not a parent node
    const parentRow = rowById.get(parentId);
    if (!parentRow) continue;  // parent was dropped (node <= 0) — nothing to reconcile against
    let childSum = 0;
    for (const childId of emitChildren.get(parentId)!) childSum += rowById.get(childId)!.spent;
    const remainder = parentRow.spent - childSum;
    if (Math.abs(remainder) < RECONCILE_EPSILON) continue;  // already sums (float-dust tolerance)
    const remainderId = `${parentId}__remainder`;
    rowById.set(remainderId, {
      id: remainderId, ...ADJUSTMENT_ROW,  // WHIT-380: shared label/icon/tone (see theme.ts)
      spent: remainder, posted: remainder, pending: 0,
      // `fmt` drops the sign, so the amount column renders a signed value (WHIT-357 R1); the sub-label
      // explains the row rather than repeating an unsigned number.
      spentLabel: 'keeps the list adding up', pct: 0, uncategorized: false,
      depth: parentRow.depth + 1, parentId, hasChildren: false, drillId: parentId, isRemainder: true,
    });
    pushEmit(parentId, remainderId);
  }

  // Total = the netted cycle spend: sum each depth-0 NON-refund row's `spent`. A parent node already
  // includes its whole subtree, so summing every node (or a node plus its flat leaves) would double-
  // count; refund + remainder lines are display-only (and always depth >= 1). Uncategorized is itself
  // a depth-0 row, so it's counted here. pct is each (non-refund, non-remainder) row's share of the total.
  let total = 0;
  for (const row of rowById.values()) if (row.depth === 0 && !row.isRefund) total += row.spent;
  for (const row of rowById.values()) row.pct = total > 0 && !row.isRefund && !row.isRemainder ? (row.spent / total) * 100 : 0;

  // Emit depth-first, siblings sorted by spent desc; an emitted-guard + trailing sweep
  // keep a corrupt cycle from dropping or duplicating a row.
  const rows: CategoryBreakdownRow[] = [];
  const emitted = new Set<string>();
  const bySpentDesc = (a: string, b: string) => rowById.get(b)!.spent - rowById.get(a)!.spent;
  const emit = (id: string) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const row = rowById.get(id);
    if (row) rows.push(row);
    for (const child of (emitChildren.get(id) ?? []).slice().sort(bySpentDesc)) emit(child);
  };
  for (const id of (emitChildren.get(null) ?? []).slice().sort(bySpentDesc)) emit(id);
  for (const id of rowById.keys()) emit(id);
  return { rows, total };
}

// One row per category, ordered as a tree for the picker (WHIT-273): each parent immediately
// followed by its children, depth-first, siblings A–Z. `depth` drives the indent, `hasChildren`
// whether to show the expand chevron. Unlike categoryBreakdown this includes EVERY category
// regardless of spend — the picker must offer them all. Cycle-safe (a corrupt A→B→A can't loop
// or drop a category), and a category whose `parent` isn't a real same-bucket category renders
// as a top-level row rather than vanishing (mirrors categoryBreakdown's same-bucket parent rule).
export interface CategoryTreeRow {
  category: Category;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
}
export function categoryTreeRows(categories: Category[]): CategoryTreeRow[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  // The parent a category actually nests under: its `parent` id, but only when that points at
  // a real same-bucket category. Otherwise null (top-level) — so orphans and cross-bucket
  // links surface instead of disappearing.
  const effectiveParent = (c: Category): string | null => {
    const parentId = c.parent ?? null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent.bucket === c.bucket) return parentId;
    return null;
  };
  const childrenByParent = new Map<string | null, Category[]>();
  for (const c of categories) {
    const key = effectiveParent(c);
    const siblings = childrenByParent.get(key);
    if (siblings) siblings.push(c); else childrenByParent.set(key, [c]);
  }
  for (const siblings of childrenByParent.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));

  const rows: CategoryTreeRow[] = [];
  const emitted = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const category of childrenByParent.get(parentId) ?? []) {
      if (emitted.has(category.id)) continue; // cycle guard
      emitted.add(category.id);
      const hasChildren = (childrenByParent.get(category.id) ?? []).length > 0;
      rows.push({ category, depth, parentId, hasChildren });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);
  // Trailing sweep: a corrupt cycle (A→B→A) leaves nodes with no root ancestor, so the walk
  // from roots never reaches them. Emit any leftover as a top-level row so no category vanishes.
  for (const category of categories) {
    if (emitted.has(category.id)) continue;
    emitted.add(category.id);
    const hasChildren = (childrenByParent.get(category.id) ?? []).length > 0;
    rows.push({ category, depth: 0, parentId: null, hasChildren });
    walk(category.id, 1);
  }
  return rows;
}

// Header label for rules whose category no longer exists (deleted category, or the
// taxonomy still cold-loading). Such rules are kept and grouped here, never dropped.
export const UNCATEGORIZED_RULE_GROUP = 'Uncategorized';

// One category's rules on the Rules screen. `category` is null for the orphan group
// (rules whose categoryId matches no known category).
export interface RuleGroup { category: Category | null; rules: Rule[]; }

// Group the Rules screen's flat rule list under one header per category, filtered by an
// optional search query. A rule is kept when the query is empty, or appears (case-
// insensitive) in its own pattern OR its category's name. Groups with no surviving rule
// are omitted, so an empty search collapses to nothing rather than a wall of blank
// headers. Real categories sort A–Z by name; the orphan "Uncategorized" group is pinned
// last. Rules keep their incoming order within a group. Pure + exported so the fast logic
// suite tests it directly and the screen stays a thin renderer.
export function groupRulesByCategory(
  rules: Rule[],
  categories: Category[],
  query = '',
): RuleGroup[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const q = query.trim().toLowerCase();

  // Preserve first-seen category order while collecting, so a stable A–Z sort below is the
  // only ordering that matters (not Map insertion quirks).
  const groupsByKey = new Map<string, RuleGroup>();
  for (const rule of rules) {
    const category = byId.get(rule.categoryId) ?? null;
    const label = category?.name ?? UNCATEGORIZED_RULE_GROUP;
    const matches =
      q === '' ||
      rule.pattern.toLowerCase().includes(q) ||
      label.toLowerCase().includes(q);
    if (!matches) continue;

    // Orphans share one bucket keyed on null; real categories key on their id.
    const key = category ? category.id : '\0orphan';
    const existing = groupsByKey.get(key);
    if (existing) existing.rules.push(rule);
    else groupsByKey.set(key, { category, rules: [rule] });
  }

  return [...groupsByKey.values()].sort((a, b) => {
    // Orphan group last; otherwise A–Z by category name.
    if (a.category === null) return 1;
    if (b.category === null) return -1;
    return a.category.name.localeCompare(b.category.name);
  });
}

export interface TransactionView {
  id: string; merchant: string; amountLabel: string; amountColor: string;
  isPending: boolean; icon: string; iconColor: string; chipBg: string;
  categoryLabel: string; categoryColor: string; categoryWeight: '500' | '700'; tappable: boolean;
}

// The taxonomy test behind isUncategorized, taking the raw category id + a lookup,
// so a caller that holds a category() lookup but not a full AppContext (the
// categorize sweep in AppProvider) shares the EXACT same "uncategorized" rule.
// A category id is unmapped when it's null OR points at an id not in the taxonomy
// (e.g. a raw BankSync enum like FOOD_AND_DRINK). 'income' is a real bucket, never
// uncategorized.
export function categoryIsUnmapped(
  categoryId: string | null,
  lookup: (id: string | null) => Category | undefined,
): boolean {
  return categoryId !== 'income' && (categoryId == null || !lookup(categoryId));
}

// WHIT-508: the display name for a category id that came back from the SERVER — a rule's target,
// a byCategory key, a conflict's disagreeing ids. The exact complement of categoryIsUnmapped:
// 'income' is a real filed bucket with no row in the taxonomy map, so a rule pointing at it must
// read "Income" rather than nothing. Anything else unresolved falls back to the raw id — never an
// empty label sitting under a count.
export function categoryLabel(
  categoryId: string,
  lookup: (id: string | null) => Category | undefined,
): string {
  if (categoryId === 'income') return 'Income';
  // `||`, not `??`: a category whose name is an empty string would otherwise render as a blank
  // label under a count — the exact thing this helper exists to prevent.
  return lookup(categoryId)?.name || categoryId;
}

// A transaction is uncategorized when it has no resolvable Abundo category: its
// category is null, or it points at an id not in the taxonomy (e.g. a raw BankSync
// category not yet mapped). 'income' is a category, not uncategorized. Single source
// of truth for the taxonomy test. Whether an uncategorized charge is an ACTIONABLE
// to-do (purple row label, the tab list, the badge, the "apply to all" sweep) is a
// second gate — contributesToBudget — so a not-in-budget transfer is uncategorized
// but not something we nag to file (WHIT-328).
// The exact slice the transaction-list selectors read — a narrow input (not the whole
// AppContext) so the migrated Transactions screen can feed it query data type-checked,
// not cast (WHIT-190a, mirrors BudgetViewsInput). AppContext satisfies it structurally,
// so every existing caller + the logic tests pass an AppContext unchanged.
export interface TransactionListInput {
  transactions: Transaction[];
  category: (id: string | null) => Category | undefined;
}

export function isUncategorized(s: Pick<TransactionListInput, 'category'>, t: Transaction): boolean {
  return categoryIsUnmapped(t.category, s.category);
}

export { contributesToBudget, paidInOneGo };

export function transactionView(s: Pick<TransactionListInput, 'category'>, t: Transaction): TransactionView {
  const uncategorized = isUncategorized(s, t);
  const isIncome = t.category === 'income';
  const amtStr = (t.amount < 0 ? '-' : '+') + '$' + Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const base = {
    id: t.transaction_id, merchant: merchantLabel(t), amountLabel: amtStr,
    amountColor: t.amount > 0 ? C.good : C.textBright,
    isPending: t.status === 'pending',
  };

  // Every uncategorized charge is the actionable purple "Uncategorized" to-do — tap to file —
  // regardless of budget status. Transfers are uncategorized too, so they're counted, listed,
  // and tappable like any other unfiled charge (WHIT-330).
  if (uncategorized) {
    return {
      ...base, icon: 'q', iconColor: C.purple, chipBg: 'rgba(160,130,240,.16)',
      categoryLabel: 'Uncategorized', categoryColor: C.purple, categoryWeight: '700', tappable: true,
    };
  }
  if (isIncome) {
    return {
      ...base, icon: 'home', iconColor: '#9aa2b5', chipBg: 'rgba(154,162,181,.14)',
      categoryLabel: 'Income', categoryColor: '#9aa2b5', categoryWeight: '500', tappable: false,
    };
  }
  const c = s.category(t.category)!;
  return {
    ...base, icon: c.icon, iconColor: c.color, chipBg: tint(c.color, 0.15),
    categoryLabel: c.name, categoryColor: C.textMid, categoryWeight: '500', tappable: false,
  };
}

export function transactionGroups(s: TransactionListInput, tab: 'all' | 'uncategorized') {
  // WHIT-330: the Uncategorized tab lists every unmapped charge, transfers included, so it
  // matches the badge and the row's "Uncategorized" label. Budget math still drops transfers.
  const tabFilter = (t: Transaction) => (tab === 'uncategorized' ? isUncategorized(s, t) : true);
  const seen = new Map<string, Transaction[]>();
  const order: string[] = [];
  for (const t of s.transactions.filter(tabFilter)) {
    const label = dateLabel(t.date);
    if (!seen.has(label)) { seen.set(label, []); order.push(label); }
    seen.get(label)!.push(t);
  }
  return order.map((label) => ({ label, items: seen.get(label)! }));
}

export function countUncategorized(s: TransactionListInput) {
  // WHIT-330: the badge counts every unmapped charge (transfers included) so it always
  // matches the row's "Uncategorized" label and the tab list.
  return s.transactions.filter((t) => isUncategorized(s, t)).length;
}

// Whether a transaction matches the Transactions-tab search box. Matches the text the user
// SEES on the row — the merchant label + raw description + the category label (Uncategorized /
// Income / the category name) — plus the amount, so "coffee", "eating out" and "42" all work,
// plus the user's own notes and tags when SEARCH_NOTES_AND_TAGS is on.
// Case-insensitive substring; `$` and `,` are stripped from the query so "$42" / "1,234" match.
// An empty query matches everything (the list is unfiltered). Pure over { category }.
// WHIT-576: the server runs the same match over ALL history (lambda_api/transaction_search.py);
// tests/fixtures/transaction_search_parity.json and a crosslang drift test keep the two in step.
export const SEARCH_NOTES_AND_TAGS = true;
export const SEARCH_QUERY_MAX_LEN = 100;
export function transactionMatchesSearch(s: Pick<TransactionListInput, 'category'>, t: Transaction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const categoryLabel = t.category === 'income' ? 'Income' : isUncategorized(s, t) ? 'Uncategorized' : (s.category(t.category)?.name ?? '');
  const parts = [merchantLabel(t), t.description || '', categoryLabel, Math.abs(t.amount || 0).toFixed(2)];
  if (SEARCH_NOTES_AND_TAGS) parts.push(t.notes ?? '', (t.tags ?? []).join(' '));
  const haystack = parts.join(' ').toLowerCase();
  return haystack.includes(q) || haystack.includes(q.replace(/[$,]/g, ''));
}

// --- Accounts (WHIT-215): the Accounts tab + the per-account detail screen -----
// Both derive ENTIRELY from the transaction list — every transaction already carries an
// `account_id` + `account_name` from BankSync — so there is no separate accounts feed.
// We group by `account_id` and pick ONE canonical name per account, so the card, its
// detail-screen header, and every row underneath always show the same label even if the
// raw feed spells an account's name slightly differently across transactions.
export interface AccountSummary {
  id: string;
  name: string;
  count: number; // how many transactions belong to this account
}

// The single display name for an account: the `account_name` seen on the most of its
// transactions. Blank names are ignored; ties resolve to the first spelling encountered
// (the list is newest-first, so the most recent name wins). Falls back to the id when an
// account has only blank names, so it still renders rather than showing an empty label.
function canonicalAccountName(transactions: Transaction[], fallbackId: string): string {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    const nm = t.account_name?.trim();
    if (nm) counts.set(nm, (counts.get(nm) ?? 0) + 1);
  }
  let name = fallbackId, best = 0;
  for (const [nm, n] of counts) if (n > best) { best = n; name = nm; }
  return name;
}

// WHIT-643: a readable name for an account known only by its id (a saved balance with no
// loaded transactions): `up-homeloan` → `Up Homeloan`.
export function accountNameFromId(id: string): string {
  return id.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// One row per distinct account_id, busiest first (a stable name tie-break keeps the order
// deterministic across renders). Feeds the Accounts tab. WHIT-643: `extraIds` (the saved
// balances' ids) adds a count-0 row for any account with no loaded transactions, so a quiet
// account like the home loan still gets a card; count 0 sorts those rows last.
export function accountSummaries(s: Pick<TransactionListInput, 'transactions'>, extraIds: Iterable<string> = []): AccountSummary[] {
  const byId = new Map<string, Transaction[]>();
  for (const t of s.transactions) {
    if (!byId.has(t.account_id)) byId.set(t.account_id, []);
    byId.get(t.account_id)!.push(t);
  }
  const out = [...byId].map(([id, txns]) => ({ id, name: canonicalAccountName(txns, id), count: txns.length }));
  for (const id of extraIds) {
    if (!byId.has(id)) out.push({ id, name: accountNameFromId(id), count: 0 });
  }
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

// The per-account detail: this account's canonical name + its transactions grouped by
// date (the same day-sectioning the All tab uses). Returns null when no transaction
// carries the id — a stale deep-link or an unknown account renders an empty state, not a
// crash.
export function accountDetail(s: TransactionListInput, accountId: string) {
  const txns = s.transactions.filter((t) => t.account_id === accountId);
  if (txns.length === 0) return null;
  return {
    id: accountId,
    name: canonicalAccountName(txns, accountId),
    groups: transactionGroups({ transactions: txns, category: s.category }, 'all'),
    count: txns.length,
  };
}

// WHIT-308/WHIT-342: the category drill-in — the transactions behind an Insights spend row.
// `drillId` is a real category id, or UNCATEGORIZED_KEY for the "?" bucket. The rows arrive
// already scoped server-side to this drill (one category, or the uncategorized bucket) over the
// selected cycle's window (/categories/{id}/transactions), so there's no client-side filtering
// — just group + total them. Returns null when the cycle is empty (a stale deep-link or an
// empty cycle → the screen's empty state, not a spinner — mirrors accountDetail).
//
// The LIST shows every row the server returned (a named category's includes refunds and
// budget-excluded ones, like accountDetail; the Uncategorized bucket is already contributing-
// only, server-side). The TOTAL mirrors the server exactly (shared/spend.py _summarise): bucket
// the signed spend (-amount) by status into posted/pending, clamp EACH at >= 0, then sum — so a
// refund-heavy category can't drive the total below the card's number.
export function categoryTransactions(s: TransactionListInput, drillId: string) {
  const txns = s.transactions;
  if (txns.length === 0) return null;
  const isUncat = drillId === UNCATEGORIZED_KEY;
  // Income is stored POSITIVE (shared/spend.py sign=+1); spend is negated. Match the server:
  // sum +amount for an Income-bucket category, -amount for spend/Uncategorized, then clamp each
  // bucket >= 0 — so an income drill totals to its positive earnings instead of clamping to $0.
  const isIncome = s.category(drillId)?.bucket === 'Income';
  const sign = isIncome ? 1 : -1;

  let posted = 0, pending = 0;
  for (const t of txns) {
    if (!contributesToBudget(t)) continue;
    if (t.status === 'posted') posted += sign * t.amount;
    else if (t.status === 'pending') pending += sign * t.amount;
  }
  posted = Math.max(0, posted);
  pending = Math.max(0, pending);

  return {
    id: drillId,
    name: isUncat ? 'Uncategorized' : (s.category(drillId)?.name ?? 'Category'),
    groups: transactionGroups({ transactions: txns, category: s.category }, 'all'),
    count: txns.length,
    total: posted + pending, posted, pending,
  };
}

// The narrow read-input for the budget-detail + budget-edit selectors (WHIT-203) — they
// read only the taxonomy lookup + budgets (+ transactions/cycle for detail), never the
// whole store. Narrowing lets the migrated budget screens feed cached query data straight
// in (the eager store is gone as of WHIT-192).
export interface BudgetDetailInput {
  category: (id: string) => Category | undefined;
  budgets: Budget[];
  // The transactions behind this budget's total: the current cycle's whole subtree,
  // already filtered server-side to the contributing rows (/budgets/{id}/transactions),
  // newest-first. So the list sums to the header instead of the old rolling 7-day feed
  // slice, which under-counted a cycle longer than the feed and dropped sub-category spend.
  transactions: Transaction[];
  cycleLen: number;
  daysLeft: number;
}
export interface BudgetEditInput {
  category: (id: string) => Category | undefined;
  budgets: Budget[];
  cycleName: () => string;
}

export type SpreadEligibility = 'hidden' | 'start' | 'edit';
export interface SpreadEligibilityResult {
  entry: SpreadEligibility;
  // Whole-cent amount the category is over its spendable envelope (0 unless over). The 'start'
  // entry prefills the spread with this, so both entry points spread the same overage (WHIT-556).
  overspend: number;
}

// The ONE rule the budget-detail button and the transaction-screen prompt both read (WHIT-556),
// so the two entry points can never diverge. Mirrors budgetDetail's spend branch exactly:
//   - spend bucket only (the server rejects a spread on Income/Savings),
//   - a real budget target (an absent budget → hidden),
//   - rollover XOR spread.
// 'edit' when a plan is already active (still reachable to edit/remove even if the cushion has
// cleared "over"); 'start' when spend is over the available envelope by at least a whole cent
// (a sub-cent overshoot would spread $0, which can't be saved); 'hidden' otherwise.
export function budgetSpreadEligibility(
  category: Category | undefined,
  budget: Budget | undefined,
): SpreadEligibilityResult {
  if (!category || !budget || category.bucket === 'Savings' || category.bucket === 'Income') {
    return { entry: 'hidden', overspend: 0 };
  }
  if (budget.spread) return { entry: 'edit', overspend: 0 };
  // Matches budgetDetail's spendable envelope exactly (WHIT-549 server value, else the parts-sum).
  const available = availableToSpend(budget);
  const spent = budget.posted + budget.pending;
  const overspend = Math.round(Math.max(0, spent - available) * 100) / 100;
  if (budget.rollover) return { entry: 'hidden', overspend };
  const entry: SpreadEligibility = spent > available && overspend >= 0.01 ? 'start' : 'hidden';
  return { entry, overspend };
}

export function budgetDetail(s: BudgetDetailInput, categoryId: string) {
  const c = s.category(categoryId);
  const b = s.budgets.find((x) => x.id === categoryId);
  if (!c || !b) return null;
  // A Savings budget has no meaningful rollup (see budgetViews) — treat it as absent
  // so the detail screen shows nothing broken (WHIT-201).
  if (c.bucket === 'Savings') return null;
  const elapsed = elapsedFrac(s);
  const isIncome = c.bucket === 'Income';
  const spreadActive = !!b.spread;
  // posted/pending come from the server rollup (computed over the window). For an
  // Income category this is positive EARNINGS toward an earn-target, not spend.
  const pending = b.pending, posted = b.posted, actual = posted + pending;
  // Rollover: the spendable envelope this cycle is target + buffer (see budgetViews); a bill
  // spread adds its signed adjustment instead (rollover XOR spread). `den` guards the bar
  // percentages against a 0/negative envelope. No rollover/spend adjustment => available == budget.
  const available = availableToSpend(b);
  const den = available > 0 ? available : (b.budget > 0 ? b.budget : 1);
  const postedPct = Math.max(0, Math.min(100, (posted / den) * 100));
  // The server already filters to contributing rows; during the optimistic window an
  // excluded row may linger, so gate on contributesToBudget before display (WHIT-525).
  const relItems = s.transactions.filter(contributesToBudget);
  const daysLeftLabel = `${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} remaining`;
  const targetPct = Math.round(elapsed * 100);
  // One line for the accumulated buffer — the same sentence as the row's note (WHIT-733).
  const carryoverLine = carryoverNote(b);
  // Bill spread status line: the dollar effect this cycle (never a bare "X of N"), with a
  // "last cycle" tag on the final slice. The screen shows this while a plan is active.
  let spreadLine = '';
  if (b.spread) {
    const adj = b.spreadAdjustment;
    const last = b.spread.index >= b.spread.cycles;
    if (adj > 0.005) spreadLine = `Bill spread: +${fmtExact(adj)} added this cycle`;
    else if (adj < -0.005) spreadLine = `Bill spread: ${fmtExact(-adj)} paid back this cycle${last ? ' (last cycle)' : ''}`;
  }
  const common = { name: c.name, icon: c.icon, color: c.color, daysLeftLabel, targetPct, relItems, relEmpty: relItems.length === 0, carryoverLine, spreadLine, spreadActive, spread: b.spread };

  if (isIncome) {
    // Earn-target (floor): over-is-good, so the status is never red. Under target
    // early in the cycle is calm ("keep earning"), not an "ease up" warning.
    const met = actual >= b.budget;
    const pendingPct = Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
    const toGo = Math.max(0, b.budget - actual);
    const perDay = toGo > 0 ? toGo / Math.max(1, s.daysLeft) : 0;
    return {
      ...common,
      spentBig: fmtExact(actual), ofBudget: 'of ' + fmt(b.budget),
      statusLabel: met ? 'Target reached — nice' : 'On track — keep earning',
      statusColor: met ? C.good : C.textInfo,
      postedPct, pendingPct, showTarget: true,
      postedColor: BAR_FILL, pendingTint: tint(BAR_FILL, 0.45),
      dailyLabel: met ? 'Target reached' : `${fmt(perDay)}/day to target`,
      // Spread is spend-only (the server rejects it on Income), so an earn-target never
      // offers it — but both return branches carry the same keys so [id].tsx compiles.
      overspend: 0, canStartSpread: false,
    };
  }

  // Spend budget (ceiling): under-is-good, over is red — measured against the AVAILABLE
  // envelope (target + buffer), so a sinking-fund draw-down isn't flagged over.
  const spent = actual;
  const over = spent > available;
  // Pace rides the base per-cycle target (not the rollover buffer), matching budgetViews'
  // list label — so the same budget reads "over plan" on both screens. The muted caution only
  // shows when the shared paceWarning rule fires (WHIT-732).
  const target = paceTarget(b, s);
  const behindPace = paceWarning({ spent, target, available, over, oneCharge: paidInOneGo(s.transactions) }, s);
  const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / den) * 100, 100 - postedPct));
  const remain = available - spent;
  const daily = remain > 0 ? remain / Math.max(1, s.daysLeft) : 0;
  // The shared eligibility rule (same one the transaction-screen prompt reads) also computes the
  // whole-cent overspend used as the spread prefill — one source, so the two screens can't diverge.
  const spreadElig = budgetSpreadEligibility(c, b);
  let statusLabel = 'On track for payday';
  let statusColor: string = C.good;
  if (over) { statusLabel = 'Over budget — ease up'; statusColor = C.bad; }
  else if (behindPace) { statusLabel = 'Over plan — ease up'; statusColor = C.textInfo; }
  return {
    ...common,
    targetPct: pacePct(target, den),
    spentBig: fmtExact(spent), ofBudget: 'of ' + fmtSignedExact(available),
    statusLabel,
    statusColor,
    postedPct, pendingPct, showTarget: !over && remain > 0.005,
    postedColor: over ? C.bad : BAR_FILL, pendingTint: tint(over ? C.bad : BAR_FILL, 0.45),
    dailyLabel: over ? 'Daily limit: $0' : `Daily limit: ${fmt(daily)}`,
    // Spreading is offered once a bill has pushed the category at least a cent over (the entry
    // prefills with `overspend`, so requiring >= 0.01 avoids offering an unsaveable $0 spread on
    // a sub-cent overshoot) and it has no plan or rollover yet. Once a plan is active the cushion
    // can flip `over` false, so the edit/remove entry keys off `spreadActive`, NOT `over`.
    overspend: spreadElig.overspend,
    canStartSpread: spreadElig.entry === 'start',
  };
}

export function budgetEditInfo(s: BudgetEditInput, categoryId: string) {
  const c = s.category(categoryId);
  const existing = s.budgets.find((b) => b.id === categoryId);
  // An Income category's budget is an earn-target (a floor), not a spend ceiling
  // (WHIT-69). `c.recent` is a SPEND average (and 0 from the server in prod), so it's
  // meaningless as an income floor — for income we suppress the recommendation and
  // the spend-history stats and reframe the copy as earnings (WHIT-169).
  const isIncome = c?.bucket === 'Income';
  // Smoothing (the unified name for rollover) and a bill spread are mutually exclusive.
  // While a spread is active the Smoothing switch is shown but locked ON — a spread is itself
  // a form of smoothing (see smoothingLocked below).
  const spreadActive = !!existing?.spread;
  const avg = c ? Math.round(c.recent) : 0;
  const last = Math.round(avg * 0.92);
  const rec = avg; // recommendBasis default: Recent average (spend only)
  const cn = s.cycleName();
  const histVals = [0.7, 0.5, 0.9, 0.6, 1.0, 0.8];
  const histLabels = ['F1', 'F2', 'F3', 'F4', 'F5', 'Now'];
  const histBars = histVals.map((v, i) => ({ h: Math.round(14 + v * 76), label: histLabels[i], last: i === 5 }));
  return {
    category: c, existing, avg, last, rec, isIncome,
    // No trustworthy income-average source, so income gets no recommended number.
    hasRecommendation: !isIncome,
    recLabel: fmt(rec),
    // Spend history figures are meaningless for an earn-target -> show a neutral dash.
    lastLabel: isIncome ? '—' : fmt(last), avgLabel: isIncome ? '—' : fmt(avg),
    periodLabel: cn.toUpperCase(),
    lastWord: cn === 'Weekly' ? 'week' : cn === 'Monthly' ? 'month' : 'fortnight',
    recommendCta: isIncome ? 'Use my average income' : 'Use my average spend',
    recPrompt: isIncome ? 'Set your income floor' : undefined,
    historyToggleLabel: isIncome ? 'View earning history' : 'View spending history',
    histBars,
    title: existing ? 'Edit budget' : 'Set budget',
    saveText: existing ? 'Update budget' : 'Add budget',
    // Smoothing switch (writes the rollover flag until WHIT-551 unifies the storage).
    // `smoothingShown` renders the row — spend-only, never Income earn-targets or Savings.
    // `smoothingLocked` shows it ON-but-disabled while a bill spread is active: a spread is a
    // form of smoothing, so the switch reads on, and save() must NOT write the flag then
    // (rollover XOR spread — the server 400s a rollover write on a spread category).
    // `rolloverOn` seeds the switch from the stored flag.
    smoothingShown: !isIncome && c?.bucket !== 'Savings',
    smoothingLocked: spreadActive,
    smoothingTitle: 'Smoothing',
    smoothingHelp:
      'Unused budget carries forward for next cycle — great for saving toward a bigger, less-frequent bill. Overspending is paid back from the cycles around it.',
    smoothingLockedHelp:
      'On while this bill is spread over several cycles. Manage the spread from the bill instead.',
    rolloverOn: existing?.rollover ?? false,
    spreadActive,
  };
}

// The narrow read-inputs for the Goal-tab + milestone selectors (WHIT-197). These
// five selectors read ONLY the user's loan facts + the live home-loan balance (and,
// for the repayment card, the last repayment) — never the pay cycle, categories, or
// the seed goal. Narrowing the param to exactly what they read lets the Goal/milestone/
// Insights screens feed cached query data straight in (type-checked, not cast). WHIT-192
// removed the eager store, so all callers now feed query data (or the Insights aiGoalSignal
// via useGoalScreenData).
// `milestones` is the user's saved paydown plan (WHIT-367); optional so goalView/paydownView/
// aiGoalSignal and every existing caller stay valid unchanged. Only milestoneView reads it, and
// an absent/empty list yields an empty view (`hasPlan:false`) — there is no built-in default.
export interface GoalViewInput { loanFacts: LoanFacts; homeLoan: HomeLoanState; milestones?: MilestoneRecord[]; }
export interface RepaymentViewInput { repayment: Repayment; }

// The Goal-tab hero + equity + contribution, computed from the user's saved loan
// facts (Loan facts card) and the LIVE balance (WHIT-8's s.homeLoan) — never the
// old seed. `factsReady` is false until the user saves the form: the screen then
// shows a friendly "set this up" state instead of any fabricated number. The
// payoff projection (mortgage-free date + interest dodged) lives in paydownView.
export function goalView(s: GoalViewInput) {
  const facts = s.loanFacts;
  const factsReady = loanFactsReady(facts);
  const liveBalance = s.homeLoan.balance;                 // real balance, null until loaded
  const balanceKnown = typeof liveBalance === 'number';

  let original: number | null = null;
  let baseRepay: number | null = null;
  let extra: number | null = null;
  let contribution: number | null = null;
  let paidOff: number | null = null;
  let paidPct = 0;
  let usableEquity: number | null = null;

  // Use the type guard inline so `facts` narrows to concrete numbers here.
  if (loanFactsReady(facts)) {
    original = facts.original;
    baseRepay = facts.baseRepay;
    extra = facts.extra;
    contribution = facts.baseRepay + facts.extra;
    // Real payoff progress + equity also need the live balance.
    if (typeof liveBalance === 'number') {
      paidOff = facts.original - liveBalance;
      paidPct = Math.max(0, Math.min(100, (paidOff / facts.original) * 100));
      usableEquity = computeUsableEquity(facts.homeValue, liveBalance, facts.lvr);
    }
  }

  // WHIT-378: the user's real next-place deposit target (optional, dollars). Null until
  // set — so we never divide by a fabricated denominator. depositPct is null (not a fake
  // 0/100) when there's no target or no equity yet, so the card's bar + "%" simply don't
  // render and it shows an honest "set your target" prompt instead.
  const depositTarget = facts.depositTarget ?? null;
  const depositPct =
    usableEquity != null && depositTarget != null && depositTarget > 0
      ? Math.max(0, Math.min(100, (usableEquity / depositTarget) * 100))
      : null;

  // WHIT-372: the coherence-clamped "% gone" headline label, shared by the Goals-hub card and
  // the /mortgage hero so they can't drift. Reads 100 ONLY when the loan is set up AND the balance
  // truly rounds to $0 (facts-unset has no original to measure, so it's never "100% gone");
  // anything still owing is floored at 99, so a residual "$X to go" never sits next to "100% gone".
  // The progress Bar still uses the raw paidPct; only this headline label is clamped.
  // WHIT-391: also floor the label at 1 whenever there's genuine (rounded-dollar) paydown — the
  // mirror of the 99-clamp above. That floors the TOP so "$X to go" never reads "100% gone"; this
  // floors the BOTTOM so a real "$X paid" figure never reads "0% gone".
  const balanceCleared = factsReady && balanceKnown && Math.round(liveBalance!) === 0;
  // One predicate for "is there genuine (rounded-dollar) paydown?", used BOTH to floor the label
  // and to gate the block (paidDownReady). Sharing it makes "block shown ⟺ label >= 1" structural
  // — the two can never drift out of sync.
  const hasRoundedPaydown = Math.round(paidOff ?? 0) > 0;
  const paidPctLabel = balanceCleared
    ? 100
    : Math.min(99, Math.max(Math.round(paidPct), hasRoundedPaydown ? 1 : 0));

  // WHIT-372: the single "is there genuine paydown to show?" flag, shared by both screens so the
  // hero and the card can't drift on it (the card already gated on this; the hero didn't). False
  // when the balance is at or above the original — no dollars paid down — so a redraw/refinance
  // that grew the loan never shows an incoherent "$1 paid" block; the screen falls back to a plain
  // "balance owing" state instead.
  const paidDownReady = factsReady && balanceKnown && hasRoundedPaydown;

  return {
    factsReady,
    liveBalance, balanceKnown, balanceLabel: balanceKnown ? fmt(liveBalance!) : '—',
    original, paidOff, paidPct, paidPctLabel, paidDownReady,
    usableEquity, depositTarget, depositPct,
    baseRepay, extra, contribution,
  };
}

// The Goal-tab payoff projection (WHIT-114): mortgage-free date + how much sooner
// and how much interest the EXTRA repayment saves — a pure loan amortization over
// the live balance (s.homeLoan) and the saved facts (s.loanFacts: ratePct,
// baseRepay, extra) on the loan's MONTHLY schedule. Forward-looking from today's
// balance; needs no payment history. `today` is injected for deterministic tests.
//
// The `mode` discriminates what the screen can honestly show:
//   'unready' → facts unset or balance not loaded → show nothing here
//   'none'    → won't pay off even with the extra (payment ≤ interest) → warn
//   'partial' → pays off ONLY because of the extra (scheduled-alone never clears)
//               → show the date, but no "X early"/"dodged" (no finite baseline)
//   'flat'    → pays off, but the extra makes no measurable difference (e.g. 0)
//   'ahead'   → pays off, and the extra saves real time + interest → full display
export type PaydownMode = 'unready' | 'none' | 'partial' | 'flat' | 'ahead';
export interface PaydownView {
  mode: PaydownMode;
  freedomLabel: string;                 // "Aug 2045"; '' when unready/none
  aheadLabel: string | null;            // "6y 6m"; set only in 'ahead'
  interestDodged: number | null;        // set only in 'ahead'
  interestDodgedLabel: string | null;   // fmt(interestDodged); set only in 'ahead'
  // WHIT-126 shortfall solver: set only in 'none' AND when the user has a valid
  // future payoff goal date; null otherwise (every other mode, or 'none' with no date).
  requiredRepay: number | null;         // $/month needed to clear the loan by the goal date
  requiredExtra: number | null;         // requiredRepay − (baseRepay + extra); always > 0 in 'none'
  requiredRepayLabel: string | null;    // fmt(requiredRepay)
  requiredExtraLabel: string | null;    // fmt(requiredExtra)
  goalDateLabel: string | null;         // "Nov 2030" — the goal date as a month-year label
  // WHIT-215: the goal date is implausibly soon — the required repayment is over the $1M cap
  // (figure suppressed) OR an absurd multiple of the current repayment (figure shown). Drives
  // the "that target may be too soon — try a later date" hint. false in every other state.
  goalTooAggressive: boolean;
}

export function paydownView(s: GoalViewInput, today?: Date): PaydownView {
  const base: PaydownView = {
    mode: 'unready', freedomLabel: '',
    aheadLabel: null, interestDodged: null, interestDodgedLabel: null,
    requiredRepay: null, requiredExtra: null, requiredRepayLabel: null,
    requiredExtraLabel: null, goalDateLabel: null, goalTooAggressive: false,
  };
  const facts = s.loanFacts;
  const balance = s.homeLoan.balance;
  // typeof narrows null away; Number.isFinite also rejects a NaN/Infinity balance
  // (which is itself typeof 'number') so it can't leak an "undefined NaN" label.
  if (!loanFactsReady(facts) || typeof balance !== 'number' || !Number.isFinite(balance)) return base;

  const i = facts.ratePct / 100 / MONTHS_PER_YEAR;

  const withExtra = amortize(balance, i, facts.baseRepay + facts.extra);
  if (!withExtra) {
    // Won't pay off at the current repayment. If the user set a valid FUTURE payoff
    // goal date, solve for the repayment needed to hit it (WHIT-126); otherwise leave
    // the shortfall fields null so the screen shows the static "won't pay off" copy.
    // A past/current-month or unparseable goal date (months ≤ 0 / null) falls back too
    // — never emit an absurd figure from a bad horizon.
    const goalDate = facts.payoffGoalDate;
    const months = goalDate ? monthsUntil(today ?? new Date(), goalDate) : null;
    if (goalDate && months !== null && months > 0) {
      const requiredRepay = requiredRepayment(balance, i, months);
      const currentRepay = facts.baseRepay + facts.extra;
      // Only present a figure the server (and so the AI) will accept — above the cap
      // the goal is unrealistically close, so fall back to the hint/static copy.
      if (requiredRepay !== null && requiredRepay <= MAX_SHORTFALL_REPAYMENT) {
        const requiredExtra = requiredRepay - currentRepay;
        const [goalYear, goalMonth] = goalDate.split('-').map(Number);
        // WHIT-215: below the cap the figure is honest but can still be absurd (e.g. 20× the
        // current repayment). Flag it so the screen nudges a later date ALONGSIDE the figure.
        // Guard currentRepay > 0 so a $0 repayment can't make every figure "too aggressive".
        return {
          ...base, mode: 'none',
          requiredRepay, requiredExtra,
          requiredRepayLabel: fmt(requiredRepay), requiredExtraLabel: fmt(requiredExtra),
          goalDateLabel: monthYear(new Date(goalYear, goalMonth - 1, 1)),
          goalTooAggressive: currentRepay > 0 && requiredRepay > AGGRESSIVE_REPAY_MULTIPLE * currentRepay,
        };
      }
      // WHIT-215: a valid future date but the required repayment is over the $1M cap (figure
      // suppressed) — the date itself is too aggressive. Flag the hint; the screen shows it
      // in place of the generic "increase your repayment" copy.
      return { ...base, mode: 'none', goalTooAggressive: true };
    }
    return { ...base, mode: 'none' };                         // no goal date / past date → plain "won't pay off"
  }

  const freedomLabel = monthYear(addMonths(today ?? new Date(), Math.ceil(withExtra.periods)));

  // "X early" + "interest dodged" compare against the scheduled-only baseline.
  // When the baseline itself never clears, the extra is what makes the loan
  // finishable — there's nothing finite to beat, so show the date alone.
  const baseline = amortize(balance, i, facts.baseRepay);
  if (!baseline) return { ...base, mode: 'partial', freedomLabel };

  const deltaMonths = baseline.periods - withExtra.periods;
  const years = Math.floor(deltaMonths / MONTHS_PER_YEAR);
  const months = Math.round((deltaMonths / MONTHS_PER_YEAR - years) * 12);
  const y = years + Math.floor(months / 12);                 // carry a rounded-up 12m
  const m = months % 12;
  const dodged = baseline.totalInterest - withExtra.totalInterest;

  // Only claim "ahead" when both a whole-month saving AND at least a dollar of
  // interest survive rounding — otherwise the extra is effectively no different.
  if ((y > 0 || m > 0) && Math.round(dodged) > 0) {
    return { ...base, mode: 'ahead', freedomLabel, aheadLabel: `${y}y ${m}m`, interestDodged: dodged, interestDodgedLabel: fmt(dodged) };
  }
  return { ...base, mode: 'flat', freedomLabel };
}

// The home-loan goal signal sent with an AI-insights generate request (WHIT-134),
// so the advice can tie spend cuts to becoming mortgage-free sooner. Pure over the
// SAME payoff projection as paydownView (the single source of truth — we never
// rebuild the amortization) + `today` (injected for tests).
//
// Returns null when there is no honest signal to send — 'unready' (facts or balance
// not loaded) or 'none' WITHOUT a valid payoff goal date. In the payoff cases
// (partial/flat/ahead) it carries the projected month, the current extra, and an
// EXACT sensitivity: how many whole months the payoff moves in per additional
// $100/month. Payoff time is convex in the payment, so this holds for $100 only —
// callers/the model must not extrapolate it to larger amounts. In the 'none' case
// WITH a goal date (WHIT-126) it instead carries the shortfall: the required
// repayment to hit that date and how much more than now that is, per month.
export function aiGoalSignal(s: GoalViewInput, today?: Date): AiGoalSignal | null {
  const pv = paydownView(s, today);

  // Shortfall (WHIT-126): the loan won't clear, but the user set a payoff goal date
  // and paydownView solved the required repayment. Send those numbers so the model
  // can tie spend cuts to closing the monthly gap. goal_date is the month-year LABEL
  // ("Nov 2030") so it matches the server's goal-date format; never the ISO string.
  // WHIT-218: but when the goal date is implausibly soon (goalTooAggressive), the
  // required figure is an absurd multiple of the current repayment — sending it would
  // have the model tie spend cuts to closing e.g. a $150k/month gap (nonsense advice).
  // Suppress the signal instead; the screen already shows the "that target may be too
  // soon — try a later date" hint (WHIT-215), so one place owns that message, not two.
  if (pv.mode === 'none' && pv.requiredRepay !== null && pv.requiredExtra !== null && pv.goalDateLabel !== null && !pv.goalTooAggressive) {
    const facts = s.loanFacts;
    if (!loanFactsReady(facts)) return null;                  // TS narrow; 'none' already implies ready
    return {
      payoff_mode: 'shortfall',
      goal_date: pv.goalDateLabel,
      required_repayment: pv.requiredRepay,
      required_extra: pv.requiredExtra,
      current_extra_monthly: facts.extra,
    };
  }

  if (pv.mode !== 'partial' && pv.mode !== 'flat' && pv.mode !== 'ahead') return null;

  const facts = s.loanFacts;
  const balance = s.homeLoan.balance;
  // pv is a payoff mode, so paydownView already proved facts are ready + balance is
  // finite; re-guard so TS narrows and a future change can't leak a NaN.
  if (!loanFactsReady(facts) || typeof balance !== 'number' || !Number.isFinite(balance)) return null;

  const i = facts.ratePct / 100 / MONTHS_PER_YEAR;
  const withExtra = amortize(balance, i, facts.baseRepay + facts.extra);
  const withMore = amortize(balance, i, facts.baseRepay + facts.extra + 100);
  const monthsSooner =
    withExtra && withMore && withExtra.periods - withMore.periods >= 0.5
      ? Math.round(withExtra.periods - withMore.periods)
      : null;

  return {
    payoff_mode: pv.mode,
    mortgage_free_date: pv.freedomLabel,
    current_extra_monthly: facts.extra,
    months_sooner_per_100_extra: monthsSooner,
  };
}

export interface LastRepaymentView {
  present: boolean;
  amountLabel: string;         // fmt(amount), '' when absent
  whenLabel: string;           // dateLabel(date), '' when absent
  splitLabel: string | null;   // "$X principal · $Y interest", or null (total only)
  // WHIT-121: a partial/unusable payload — amount XOR date present, but not both. Distinct
  // from a genuinely-empty repayment (all null): the card shows its error state for this,
  // not the "No repayment on record yet" empty copy, because the server DID send something
  // — we just can't render half a repayment. false whenever `present` is true.
  malformed: boolean;
}

// The Goal-tab "last repayment" card (WHIT-115): the most recent real home-loan
// repayment from s.repayment (server-derived), or a graceful empty state when
// none is on record. The principal/interest split shows only when the server
// could pair the interest leg — never a fabricated split. Pure over s.repayment.
export function lastRepaymentView(s: RepaymentViewInput): LastRepaymentView {
  const r = s.repayment;
  if (r.amount == null || r.date == null) {
    // Some field present but not the amount+date pair we need → malformed (an error), not
    // the honest "none on record" empty. All-null is genuinely empty (malformed:false).
    const malformed = r.amount != null || r.date != null;
    return { present: false, amountLabel: '', whenLabel: '', splitLabel: null, malformed };
  }
  const splitLabel = r.principal != null && r.interest != null
    ? `${fmt(r.principal)} principal · ${fmt(r.interest)} interest`
    : null;
  return { present: true, amountLabel: fmt(r.amount), whenLabel: dateLabel(r.date), splitLabel, malformed: false };
}

// ---------------------------------------------------------------------------
// Home Loan Milestone screen (WHIT-8)
// ---------------------------------------------------------------------------

export interface MilestoneRow {
  sprint: number; label: string; targetBalance: number; targetEquity: number | null;
  targetDate: string; cleared: boolean;
}

export interface MilestoneView {
  hasBalance: boolean;             // false until the live balance has loaded
  balance: number;                 // 0 when unknown — gate on hasBalance
  balanceLabel: string;
  asOf: string | null;
  equityKnown: boolean;            // false until the user has saved property value + LVR
  propertyValue: number | null;
  usableEquity: number | null;
  usableEquityLabel: string;
  hasPlan: boolean;                // false until the user has SAVED at least one milestone (no default)
  overallPct: number;              // 0..100 from the Sprint 0 balance down to the final target
  clearedCount: number;
  total: number;
  nextMilestone: MilestoneRow | null;
  amountToNext: number;
  amountToNextLabel: string;
  rows: MilestoneRow[];
  schedule: {
    ahead: boolean; onTrack: boolean; deltaAmount: number; expectedBalance: number; label: string;
  } | null;                        // null until the live balance has loaded
}

// The planned loan balance on day `t` (UTC-midnight ms), read off the piecewise-
// linear curve through the plan's anchors: flat before the first anchor and after
// the final target, linearly interpolated between. The plan's strictly-increasing-
// date ordering guarantees the interpolation denominator is never zero. Pure over
// the passed-in plan (the saved milestones, or the built-in default).
function expectedBalanceAt(t: number, plan: readonly { targetBalance: number; targetDate: string }[]): number {
  const first = plan[0];
  const last = plan[plan.length - 1];
  if (t <= milestoneTime(first)) return first.targetBalance;
  if (t >= milestoneTime(last)) return last.targetBalance;
  for (let i = 1; i < plan.length; i++) {
    const a = plan[i - 1], b = plan[i];
    const ta = milestoneTime(a), tb = milestoneTime(b);
    if (t < tb) {
      return a.targetBalance + (b.targetBalance - a.targetBalance) * ((t - ta) / (tb - ta));
    }
  }
  return last.targetBalance; // unreachable (t < last handled above), keeps TS happy
}

// Percent progress from the plan's first target down to its last, clamped 0..100. A
// single-row saved plan has start === end (a zero span): treat it as fully done once the
// balance is at or below that lone target, else not started — rather than dividing by zero
// (which NaNs when the balance sits exactly on the target). The built-in default (5 rows)
// never hits the degenerate branch.
function overallProgressPct(balance: number, start: number, end: number): number {
  if (start === end) return balance <= end ? 100 : 0;
  return Math.max(0, Math.min(100, ((start - balance) / (start - end)) * 100));
}

// Progress against the paydown plan (WHIT-8). Pure over the live home-loan balance
// (s.homeLoan) + the plan + `today` (injected for tests). The plan is the user's
// saved milestones (WHIT-367), or the built-in default when they haven't saved one.
// Until the balance loads, hasBalance is false and the schedule verdict is null so
// the screen can show a waiting state instead of fake numbers.
export function milestoneView(s: GoalViewInput, today?: Date): MilestoneView {
  const rawBalance = s.homeLoan.balance;
  const hasBalance = typeof rawBalance === 'number';
  const balance = hasBalance ? rawBalance! : 0;

  // Equity needs the user's saved property value + LVR (Loan facts card); until
  // they're set, equity figures show a "set this up" state rather than a fake number.
  const homeValue = s.loanFacts.homeValue;
  const lvr = s.loanFacts.lvr;
  const equityKnown = typeof homeValue === 'number' && typeof lvr === 'number';
  const equity = equityKnown && hasBalance ? computeUsableEquity(homeValue!, balance, lvr!) : null;

  // The user's SAVED milestone plan — empty until they set one. There is no hardcoded default:
  // a user who hasn't set milestones gets an empty view (`hasPlan:false`), and the screens show a
  // "set your payoff milestones" prompt instead of a fake plan. A saved MilestoneRecord has no
  // `sprint`, so the step number is derived from list position below.
  const plan = s.milestones ?? [];
  if (plan.length === 0) {
    return {
      hasBalance, balance, balanceLabel: hasBalance ? fmt(balance) : '—', asOf: s.homeLoan.asOf,
      equityKnown, propertyValue: equityKnown ? homeValue! : null,
      usableEquity: equity, usableEquityLabel: equity != null ? fmt(equity) : '—',
      hasPlan: false, overallPct: 0, clearedCount: 0, total: 0,
      nextMilestone: null, amountToNext: 0, amountToNextLabel: '—', rows: [], schedule: null,
    };
  }

  const rows: MilestoneRow[] = plan.map((m, i) => ({
    sprint: i,
    label: m.label,
    targetBalance: m.targetBalance,
    targetEquity: equityKnown ? computeUsableEquity(homeValue!, m.targetBalance, lvr!) : null,
    targetDate: m.targetDate,
    // A milestone is cleared once the balance is at or below its target (paying
    // down). Unknown balance clears nothing.
    cleared: hasBalance && balance <= m.targetBalance,
  }));

  const clearedCount = rows.filter((r) => r.cleared).length;
  // The next milestone is the first (earliest, highest-balance) target still
  // above the current balance. null once every target is reached.
  const next = hasBalance ? rows.find((r) => !r.cleared) ?? null : null;
  const amountToNext = next ? balance - next.targetBalance : 0;

  const start = plan[0].targetBalance;
  const end = plan[plan.length - 1].targetBalance;
  const overallPct = hasBalance ? overallProgressPct(balance, start, end) : 0;

  let schedule: MilestoneView['schedule'] = null;
  if (hasBalance) {
    const now = today ?? new Date();
    const t = dateToUtcDayMs(now);
    const expectedBalance = expectedBalanceAt(t, plan);
    const delta = expectedBalance - balance;   // >0 => balance lower than planned => ahead
    const deltaAmount = Math.abs(delta);
    const ahead = delta > 0;
    // Within ~$100 of plan reads as on track rather than a distracting tiny delta.
    const onTrack = deltaAmount < 100;
    const label = onTrack
      ? 'On track with the plan'
      : `${fmt(deltaAmount)} ${ahead ? 'ahead of' : 'behind'} schedule`;
    schedule = { ahead, onTrack, deltaAmount, expectedBalance, label };
  }

  return {
    hasBalance,
    balance,
    balanceLabel: hasBalance ? fmt(balance) : '—',
    asOf: s.homeLoan.asOf,
    equityKnown,
    propertyValue: equityKnown ? homeValue! : null,
    usableEquity: equity,
    usableEquityLabel: equity != null ? fmt(equity) : '—',
    hasPlan: true,
    overallPct,
    clearedCount,
    total: rows.length,
    nextMilestone: next,
    amountToNext,
    amountToNextLabel: next ? fmt(amountToNext) : '—',
    rows,
    schedule,
  };
}
