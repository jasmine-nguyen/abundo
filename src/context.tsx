import React, { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { C, tint, fmt, fmtExact, ADJUSTMENT_ROW, RECONCILE_EPSILON } from './theme';
import { normalizeColorSlot } from './chartColors';
import { colorForCategory } from './categoryColors';
import { writeFailureMessage, ApiError } from './apiError';
import { MONTHS, isoToUtcDayMs, dateToUtcDayMs, wholeDaysBetween } from './dateutil';
import { createCategory, updateCategory, deleteCategory as apiDeleteCategory, setBudget as apiSetBudget, deleteBudget as apiDeleteBudget, setSpread as apiSetSpread, deleteSpread as apiDeleteSpread, setTransactionCategory as apiSetTransactionCategory, setTransactionCategories as apiSetTransactionCategories, setTransactionFields as apiSetTransactionFields, setPayCycle as apiSetPayCycle, setLoanFacts as apiSetLoanFacts, saveGoal as apiSaveGoal, deleteGoal as apiDeleteGoal, setMilestones as apiSetMilestones, GoalRecord, GoalWriteBody, LoanFacts, LoanFactsInput, MilestoneRecord, Repayment, BudgetRollup, SpreadPlan, CategorySpend, BreakdownRollup, createRule, updateRule as apiUpdateRule, deleteRule as apiDeleteRule, RuleRecord, RuleCondition, RuleLogic, fetchAiInsights, generateAiInsights as apiGenerateAiInsights, AiInsights, AiGoalSignal, TransactionFeedPage, applyRulesToUncategorized, ApplyRulesResult, startApplyRulesJob as apiStartApplyRulesJob, getApplyRulesJob as apiGetApplyRulesJob, ApplyRulesJob, UncategorizedMerchantGroup } from './api';
import * as Crypto from 'expo-crypto';
import { usableEquity as computeUsableEquity, milestoneTime } from './milestones';
import { reinsertBefore } from './reinsert';
import { RULE_FIELD_OPERATORS } from './ruleVocabulary';

export type { LoanFacts, LoanFactsInput } from './api';
export type { ApplyRulesResult, ApplyRulesJob } from './api';
// WHIT-517: the outcome of a "file by shop" preview or write. On failure, `clash` carries the
// server's 409 ApiError when an existing rule would fight this one (so the sheet can explain it),
// and is null for any other failure. Kept distinct from applyRulesToHistory's plain null, which
// erases that difference.
export type FileByShopOutcome =
  | { ok: true; report: ApplyRulesResult }
  | { ok: false; clash: ApiError | null };
// WHIT-560: the outcome of STARTING an async apply-rules job. `ok` means the job was accepted
// (202) and polling has begun; on failure `clash` carries the 409 ApiError when an existing rule
// would fight an inline "file this shop / add rule" job (null for a bad-rule 400 or a 502 the sheet
// shows as a generic "couldn't start"). The job's own running/done/failed state is read separately
// from `applyRulesJob`.
export type ApplyRulesJobStart =
  | { ok: true }
  | { ok: false; clash: ApiError | null };
// WHIT-190a: the categorise write double-writes the query cache (for the migrated
// Transactions list) alongside the old store (for the tab badge + budget detail).
// Import the singleton directly (not the ['transactions'] key from ./queries) to avoid
// a circular import — ./queries imports from this module.
import { queryClient } from './queryClient';
import type { InfiniteData } from '@tanstack/react-query';
import { getStatus, subscribe } from './auth';

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Bucket = 'Living' | 'Lifestyle' | 'Income' | 'Savings';

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  bucket: Bucket;
  recent: number;
  // Id of the parent this category rolls up into; null (or absent) means
  // top-level. Optional so existing category literals stay valid; toCategory
  // always normalises it to a value.
  parent?: string | null;
  // The server's permanent chart-colour slot, an integer in [0,20). Optional so existing
  // category literals — and a server that predates slots — stay valid; absent means the
  // Insights chart falls back to the id-derived colour.
  colorSlot?: number;
}
export interface Budget {
  id: string; budget: number; posted: number; pending: number;
  // Rollover (envelope carryover). `rollover` off => `carryover` is ignored. `carryover` is
  // the signed buffer this cycle adds to the target (positive = saved up, negative = a prior
  // spike's overspend carried as a deficit). Default off/0 for a non-rollover/legacy budget.
  rollover: boolean; carryover: number;
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
export interface Transaction {
  transaction_id: string;
  date: string;            // "YYYY-MM-DD"
  authorized_date: string;
  description: string;
  merchant_name: string;
  amount: number;
  account_id: string;
  account_name: string;
  category: string | null;
  status: 'pending' | 'posted';
  type: string;
  counts_to_budget: boolean;
  // WHIT-275: user-authored, optional. Absent when never set or cleared (the
  // server REMOVEs a cleared field, so it reads back undefined, not ""/[]).
  notes?: string;
  tags?: string[];
  // WHIT-296: user override to exclude this transaction from budgets ("mark as
  // transfer"). Absent (undefined) = not excluded; only True is stored server-side.
  budget_excluded?: boolean;
  // WHIT-536/539: the store id of the rule that auto-filed this charge's category.
  // Server-stamped, sparse — absent when filed by hand or by the bank. The detail
  // screen resolves it against the rules cache to explain the category (WHIT-539).
  filed_by_rule?: string;
}
// `pattern` mirrors the server rule's `value`; `field`/`operator` carry the
// server facts (default description/contains for app-authored rules) so a rule
// surfaced from BankSync renders truthfully. `isNew` flags the "NEW" badge and
// is client-only (server rules load as isNew:false).
export interface Rule { id: string; pattern: string; categoryId: string; isNew: boolean; field?: string; operator?: string; budgetExcluded?: boolean; conditions?: RuleCondition[] | null; logic?: RuleLogic | null; }
// WHIT-563: the multi-condition payload a rule writer sends when the builder produced more than a
// plain "description contains" rule. Absent on the classic single-condition path (which stays a
// flat value write, preserving the WHIT-538 preview flow and pattern-based conflict detection).
export interface RuleWrite { conditions: RuleCondition[]; logic: RuleLogic; }
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
// The live home-loan balance from BankSync (WHIT-8). `balance` is the outstanding
// mortgage principal as a positive number, null until the balance poller's first
// run lands.
export interface HomeLoanState { balance: number | null; asOf: string | null; }
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
// (lambda_api/constants.py) — the "All from this merchant" sweep splits into chunks
// of this size so a large merchant spans multiple requests instead of tripping the
// server's per-request cap. Keep the two equal.
const CATEGORY_BATCH_LIMIT = 100;

// Max charges ONE apply-rules request writes. Mirrors the server's APPLY_RULES_MAX_WRITES
// (lambda_api/constants.py) — the parity is asserted by applyRulesCap.logic.test.ts, since a
// comment alone drifts. With ~639 unfiled charges the FIRST run is expected to be partial, so
// the preview says so UP FRONT instead of promising a number one tap can't deliver. The server
// can stop even earlier (a wall-clock budget), hence "up to" in the copy. Keep the two equal.
export const APPLY_RULES_MAX_WRITES = 300;

// WHIT-560: the async "apply rules over all history" background job (no cap). The app polls the
// job's status on a SELF-SCHEDULING loop — the next poll is armed only after the current one
// resolves — so polls can never overlap or land out of order regardless of the per-poll timeout.
const APPLY_RULES_JOB_POLL_DELAY_MS = 2500;
// A dropped poll (offline/airplane) is NOT a job failure — the sweep keeps running server-side.
// Tolerate this many CONSECUTIVE network throws, then give up so the sheet isn't stuck polling a
// truly unreachable server. A server `status:"failed"` or a 404 (expired) is terminal immediately.
const APPLY_RULES_JOB_MAX_NET_ERRORS = 5;

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
  return cleanName(t.merchant_name || t.description);
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

// The pay-cycle length -> its human name. Pure + exported so the provider and the
// tests share one source of truth (rather than each reimplementing the mapping).
export function cycleName(length: number): 'Weekly' | 'Fortnightly' | 'Monthly' {
  return length === 7 ? 'Weekly' : length === 14 ? 'Fortnightly' : 'Monthly';
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
  // WHIT-508: preview what the existing rules would file across stored history. Writes nothing.
  previewRuleApplication: () => Promise<ApplyRulesResult | null>;
  // WHIT-508: file what the rules cover, capped at APPLY_RULES_MAX_WRITES per call. Returns the
  // server's report (null on failure, where the outcome is unknown and the caches are refreshed).
  applyRulesToHistory: () => Promise<ApplyRulesResult | null>;
  // WHIT-517: preview / file one shop from the "File by shop" screen. Both return a distinct 409
  // clash outcome (an existing rule would fight this one) instead of a bare null.
  previewFileByShop: (group: UncategorizedMerchantGroup, categoryId: string) => Promise<FileByShopOutcome>;
  fileByShop: (group: UncategorizedMerchantGroup, categoryId: string) => Promise<FileByShopOutcome>;
  // WHIT-538: preview / file the stored charges a NOT-YET-CREATED rule would catch. previewNewRule
  // dry-runs the typed pattern (writes nothing); fileNewRule mints the rule AND files those charges
  // in one call. Both return the same 409-clash-aware outcome as the file-by-shop pair.
  previewNewRule: (pattern: string, categoryId: string, budgetExcluded?: boolean) => Promise<FileByShopOutcome>;
  fileNewRule: (pattern: string, categoryId: string, budgetExcluded?: boolean) => Promise<FileByShopOutcome>;
  // WHIT-560: the async "apply my rules over all history" job (no 300/15s cap). `applyRulesJob` is
  // the live status the sheet renders (null when idle); the three starters begin a job and kick off
  // polling — the plain sweep, and the inline "file this shop" / "add rule" variants (which mint a
  // rule and can clash 409). A running job blocks the sync writers above (one heavy run at a time).
  applyRulesJob: ApplyRulesJob | null;
  startApplyRulesSweep: () => Promise<ApplyRulesJobStart>;
  startFileByShopJob: (group: UncategorizedMerchantGroup, categoryId: string) => Promise<ApplyRulesJobStart>;
  startNewRuleJob: (pattern: string, categoryId: string, budgetExcluded?: boolean) => Promise<ApplyRulesJobStart>;
  retryApplyRulesJob: () => Promise<ApplyRulesJobStart>;
  applyTransactionEdit: (txId: string, patch: { notes?: string; tags?: string[]; budget_excluded?: boolean }) => Promise<void>;
  saveBudget: (categoryId: string, value: number, rollover?: boolean) => Promise<boolean>;
  deleteBudget: (categoryId: string) => Promise<boolean>;
  saveSpread: (categoryId: string, amount: number, cycles: number) => Promise<boolean>;
  removeSpread: (categoryId: string) => Promise<boolean>;
  saveCategory: (editId: string | null, form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }) => Promise<boolean>;
  createCategoryInline: (form: { name: string; bucket: Bucket; icon: string; parent?: string | null }, opts?: { silent?: boolean }) => Promise<Category | null>;
  deleteCategory: (id: string) => Promise<boolean>;
  deleteRule: (id: string) => Promise<void>;
  saveManualRule: (pattern: string, categoryId: string, budgetExcluded?: boolean, write?: RuleWrite) => Promise<void>;
  updateRule: (id: string, pattern: string, categoryId: string, budgetExcluded?: boolean, write?: RuleWrite) => Promise<void>;
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
    spreadAdjustment: rollup.spread?.adjustment ?? 0, spread: rollup.spread,
    // Pass through the server-computed spendable; stays undefined when the server omits it,
    // so the screens' `?? <parts-sum>` fallback fires (WHIT-549).
    available: rollup.available,
  };
}

// Bill-spread cycle bounds the app offers, mirroring the server (SPREAD_MIN/MAX_CYCLES,
// lambda_api/constants.py). Advisory only — the server re-validates and 400s a bad value —
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

// Map a server rule into the client `Rule` shape. `value` -> `pattern`
// (what the list renders); loaded rules are never "new". Module-level + exported
// (WHIT-195) so the ['rules'] query's selectRules reuses the exact same mapping.
export function toRule(raw: RuleRecord): Rule {
  return { id: raw.id, pattern: raw.value, categoryId: raw.categoryId, isNew: false, field: raw.field, operator: raw.operator, budgetExcluded: raw.budgetExcluded, conditions: raw.conditions, logic: raw.logic };
}

const Ctx = createContext<AppContext | null>(null);

// A charge can live in TWO caches: the Transactions tab's ['transactions'] FEED (an InfiniteData
// of pages — the "Load More" history) and the bounded ['transactionsRecent'] window (the tab-bar
// dot, account-detail, goal-edit). They overlap on the newest rows but each holds some the other
// doesn't (deep history is feed-only; a recent charge beyond the feed's loaded pages is
// recent-only). So the write path must READ the union (or a row tapped on account-detail is
// "not found" and the write silently no-ops) and PATCH both (or the dot/account-detail keep stale
// data after an edit). These helpers own that reconciliation for every writer.
function readFeedRows(): Transaction[] {
  const data = queryClient.getQueryData<InfiniteData<TransactionFeedPage>>(['transactions']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
// The Uncategorized tab's own paged feed (its loaded pages). A deep-history unfiled charge shown
// on that tab lives ONLY here — not in the general feed's loaded pages nor the recent window — so
// the union below must include it, or tapping it on the tab would "not find" the row and the
// categorise would silently no-op.
function readUncategorizedFeedRows(): Transaction[] {
  const data = queryClient.getQueryData<InfiniteData<TransactionFeedPage>>(['uncategorizedFeed']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
// The union of the three list caches, de-duped by id (a charge in more than one appears once).
// Newest-first from the feed, then uncategorized-feed-only rows, then recent-only rows.
function readTransactionsCache(): Transaction[] {
  const feed = readFeedRows();
  const uncategorized = readUncategorizedFeedRows();
  const recent = queryClient.getQueryData<Transaction[]>(['transactionsRecent']) ?? [];
  const seen = new Set(feed.map((t) => t.transaction_id));
  const merged = [...feed];
  for (const row of [...uncategorized, ...recent]) {
    if (seen.has(row.transaction_id)) continue;
    seen.add(row.transaction_id);
    merged.push(row);
  }
  return merged;
}
// Map the caller's per-row transform over the feed pages, the uncategorized-feed pages (page
// boundaries + cursors preserved) AND the flat recent array, so an optimistic edit reflects on the
// tab list, the uncategorized tab, the dot, account-detail, and goal-edit at once.
// On the uncategorized tab this is what drops a just-filed
// row from the list instantly: the row stays in the cached page but no longer matches the client
// re-filter, so it disappears without a whole-history re-scan.
// Most callers are a plain .map() that adds and removes no rows. The exception is WHIT-508's
// apply-rules reconcile, which also REMOVES rows the server reported as deleted mid-run: safe
// because page boundaries and cursors are untouched and the feeds already tolerate a sparse or
// empty page (see useUncategorizedFeedQuery).
function patchInfiniteFeed(key: readonly unknown[], fn: (prev: Transaction[]) => Transaction[]): void {
  queryClient.setQueryData<InfiniteData<TransactionFeedPage>>(key, (prev) =>
    prev ? { ...prev, pages: prev.pages.map((pg) => ({ ...pg, transactions: fn(pg.transactions) })) } : prev);
}
function patchTransactionsCache(fn: (prev: Transaction[]) => Transaction[]): void {
  patchInfiniteFeed(['transactions'], fn);
  patchInfiniteFeed(['uncategorizedFeed'], fn);
  queryClient.setQueryData<Transaction[]>(['transactionsRecent'], (prev) => (prev ? fn(prev) : prev));
}

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
  // WHIT-508: one apply-rules run at a time, held here rather than in the sheet — see the writer.
  const applyRulesInFlight = useRef(false);
  // WHIT-560: the async background job. `applyRulesJob` is the status the sheet renders; the refs
  // drive the self-scheduling poll loop and the "one heavy run at a time" lock, which must live in
  // the provider (it outlives the sheet, which unmounts on dismiss/lock). `applyRulesJobActive`
  // stays true from the accepted POST until the job is terminal OR the session ends — the sync
  // writers check it too, so a sync sweep can't start on top of a running job even after the sheet
  // is dismissed (polling stops on dismiss and resumes on reopen; the lock does not).
  const [applyRulesJob, setApplyRulesJob] = useState<ApplyRulesJob | null>(null);
  const applyRulesJobId = useRef<string | null>(null);
  const applyRulesPollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const applyRulesNetErrors = useRef(0);
  const applyRulesJobActive = useRef(false);
  // Bumped by every poll teardown (terminal, dismiss, lock, sign-out). A poll captures it before its
  // await and bails without re-arming if it changed — so a GET that was in flight when the sheet was
  // dismissed can't resurrect the timer, and a dismiss-then-reopen can never leave two live chains.
  const applyRulesPollGen = useRef(0);
  // The variant + args of the RUNNING job, so "Try again" always restarts the SAME sweep — even when
  // the job view is rendered from a different sheet than the one that started it (applyRulesJob is
  // global). Without this, a failed file-this-shop job's retry from the plain sheet would run a
  // whole-rules sweep instead.
  const applyRulesJobRetryArgs = useRef<{ rule?: { value: string; categoryId: string; budgetExcluded?: boolean }; prependRule: boolean } | null>(null);
  const applyRulesJobStartEpoch = useRef(0);
  // True only for the "add rule" (Rules screen) variant: on success prepend the minted rule with
  // its NEW badge (like fileNewRule), skipping the rules refetch. False for the plain sweep and
  // "file this shop", which refresh rules normally.
  const applyRulesJobPrependRule = useRef(false);
  // The latest poll callback, read through a ref so a scheduled timer always runs the freshest
  // closure (over refreshAfterApplyRules etc.) rather than a stale one captured at schedule time.
  const applyRulesPollRef = useRef<() => void>(() => {});
  // WHIT-566: the shared core of every apply-rules poll teardown — clear the timer, forget its
  // handle, and bump the generation so an in-flight poll bails without re-arming. All three teardown
  // sites (sign-out/lock, sheet-dismiss, endApplyRulesJob) route through this so the delicate order
  // lives once. Ref-only → stable identity (empty deps), so it perturbs no effect's dependencies.
  const stopApplyRulesPolling = useCallback(() => {
    clearTimeout(applyRulesPollTimer.current);
    applyRulesPollTimer.current = undefined;
    applyRulesPollGen.current += 1;
  }, []);
  const readSheetDraft = useCallback((key: string): unknown => sheetDrafts.current.get(key), []);
  const writeSheetDraft = useCallback((key: string, value: unknown) => { sheetDrafts.current.set(key, value); }, []);
  // WHIT-192: rule edits are mirrored straight into the ['rules'] query cache the Rules
  // screen + Settings count read (the old eager store is gone). Applies the functional
  // updater to the cache — including the client-only isNew "NEW" badge, which a refetch
  // would reset to false. Guards an evicted/absent cache (gcTime is finite): when the
  // Rules screen was never opened there's nothing to patch, and opening it fetches fresh.
  // Literal ['rules'] key (not the queries.ts const) to avoid a circular import.
  const patchRules = useCallback((fn: (prev: Rule[]) => Rule[]) => {
    queryClient.setQueryData<Rule[]>(['rules'], (prev) => (prev ? fn(prev) : prev));
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

	// AI spending insights (WHIT-104). `refreshAiInsights` reads the per-cycle cache
	// (free); `generateAiInsights` is the paid "Analyse my spending" action. Error is
	// true only when the last GENERATE failed, so the button can show a retry; a
	// null-summary cache (nothing generated yet) is NOT an error.
	const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
	const [aiInsightsLoading, setAiInsightsLoading] = useState(false);
	const [aiInsightsError, setAiInsightsError] = useState(false);
	const refreshAiInsights = useCallback(async () => {
		const epoch = sessionEpoch.current;
		try {
			const result = await fetchAiInsights();
			if (epoch !== sessionEpoch.current) return; // signed out mid-flight
			setAiInsights(result);
		} catch {
			// A failed cache read leaves the current state intact (no error surfaced);
			// the user can still generate.
		}
	}, []);
	// `goal` is passed IN by the caller (computed from live state at tap time), not
	// read from a closure here — so this stays a stable useCallback([]) and can never
	// send a stale goal.
	const generateAiInsights = useCallback(async (goal?: AiGoalSignal | null) => {
		const epoch = sessionEpoch.current;
		setAiInsightsLoading(true);
		setAiInsightsError(false);
		try {
			const result = await apiGenerateAiInsights(goal);
			if (epoch !== sessionEpoch.current) return; // signed out mid-flight
			setAiInsights(result);
		} catch {
			if (epoch === sessionEpoch.current) setAiInsightsError(true);
		} finally {
			// Only the run that still owns the session may clear the spinner. A stale run
			// (signed out, then a NEW session started its own generate) must NOT flip the
			// live run's spinner off — that would let the new user double-fire.
			if (epoch === sessionEpoch.current) setAiInsightsLoading(false);
		}
	}, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clear the toast timer on unmount so it can't fire a setState after teardown (a leak
  // that also kept the jest worker alive between tests).
  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    clearTimeout(applyRulesPollTimer.current); // WHIT-560: no zombie poll after the provider unmounts
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
      // the lock here matches the sheet's own lock→fresh-start model (WHIT-508). WHIT-566: the full
      // teardown (poll stop + id/net-errors/lock reset) is endApplyRulesJob; drop the view too.
      endApplyRulesJob();
      setApplyRulesJob(null);
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

  // WHIT-560: polling follows an open overlay. While any sheet is open and a job is active but no
  // timer is armed (e.g. the sheet was just reopened after a dismiss), resume the poll from the
  // stored id. When the overlay is fully dismissed, STOP polling — the job keeps running server-side
  // and the lock stays held (block until it finishes) — and drop a terminal frame so the next open
  // previews fresh.
  useEffect(() => {
    if (sheet !== null) {
      if (applyRulesJobActive.current && applyRulesJobId.current && !applyRulesPollTimer.current) {
        applyRulesPollTimer.current = setTimeout(() => applyRulesPollRef.current(), APPLY_RULES_JOB_POLL_DELAY_MS);
      }
      return;
    }
    // WHIT-566: stop polling only (supersede any in-flight poll so it can't re-arm after dismiss);
    // deliberately partial — the job keeps running server-side and the lock stays held so a reopen
    // resumes the same job. Never route this through endApplyRulesJob (that releases the lock).
    stopApplyRulesPolling();
    if (!applyRulesJobActive.current) setApplyRulesJob(null);
  }, [sheet]);

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
      const prev = queryClient.getQueryData<{ length: number; last_pay_date: string }>(['payCycle']);
      if (!prev) return;
      const next = mutate(prev);
      // Drop any stale server days_left from the optimistic write — the new length/payday
      // changes it, so let cycleClockView fall back to the local cycleClock until the
      // invalidate below refetches the authoritative value (WHIT-341).
      const optimistic = { length: next.length, last_pay_date: next.last_pay_date };
      queryClient.setQueryData(['payCycle'], optimistic);
      // WHIT-271: if the user signs out during the round-trip, clearSession() wipes the cache
      // and bumps the epoch — a late success/failure here must NOT re-seat the old cycle or
      // toast into the next session. (The forward write above is pre-await, so clear() covers it.)
      const epoch = sessionEpoch.current;
      try {
        await apiSetPayCycle(optimistic);
        if (epoch !== sessionEpoch.current) return; // signed out mid-flight
        // The window (length and/or payday) changed, so the server rollups move — refetch
        // the migrated Budgets/Insights reads. Also refetch ['payCycle'] so the server's
        // authoritative days_left is recomputed for the new settings (WHIT-341); the flat
        // ['budgets']/['breakdown'] keys make each of these a single refresh (WHIT-72).
        queryClient.invalidateQueries({ queryKey: ['payCycle'] });
        queryClient.invalidateQueries({ queryKey: ['budgets'] });
        queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      } catch {
        if (epoch !== sessionEpoch.current) return; // signed out mid-flight
        queryClient.setQueryData(['payCycle'], prev);
        showToast('Could not save pay cycle. Please try again.');
      }
    },
    [showToast],
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
    const prev = queryClient.getQueryData<LoanFacts>(['loanFacts']) ?? EMPTY_LOAN_FACTS;
    queryClient.setQueryData(['loanFacts'], next);
    // WHIT-271: a sign-out during the round-trip must make this a no-op — no re-seat of the
    // old mortgage details, no toast, and no `true` (which would fire the form's router.back()
    // after the auth gate already redirected to login). The form unmounts on sign-out anyway.
    const epoch = sessionEpoch.current;
    try {
      await apiSetLoanFacts(next);
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      queryClient.invalidateQueries({ queryKey: ['loanFacts'] });
      return true;
    } catch {
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      queryClient.setQueryData(['loanFacts'], prev);
      showToast('Could not save loan details. Please try again.');
      return false;
    }
  }, [showToast]);

  // Save the milestone editor's plan: optimistically write the ['milestones'] cache the milestone
  // + mortgage screens read, PUT the whole ordered list, invalidate to reconcile. Roll the cache
  // back + toast on failure — the same optimistic pattern as saveLoanFacts. The invalidate is
  // load-bearing: milestones is SECONDARY in useGoalScreenData (out of that composite's refetch),
  // so this save's own invalidation is what refreshes the screen (WHIT-367 wired it that way).
  const saveMilestones = useCallback(async (next: MilestoneRecord[]): Promise<boolean> => {
    const prev = queryClient.getQueryData<MilestoneRecord[]>(['milestones']) ?? [];
    queryClient.setQueryData(['milestones'], next);
    // WHIT-271: a sign-out during the round-trip must make this a no-op — no re-seat of the old
    // plan, no toast, and no `true` (which would fire the editor's router.back() post-redirect).
    const epoch = sessionEpoch.current;
    try {
      await apiSetMilestones(next);
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      queryClient.invalidateQueries({ queryKey: ['milestones'] });
      return true;
    } catch {
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      queryClient.setQueryData(['milestones'], prev);
      showToast('Could not save milestones. Please try again.');
      return false;
    }
  }, [showToast]);

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
    const transactions = readTransactionsCache();
    const categories = queryClient.getQueryData<Category[]>(['categories']) ?? [];
    const transaction = transactions.find((t) => t.transaction_id === txId);
    const category = categories.find((c) => c.id === categoryId);
    if (!transaction || !category) {
      setSheet(null); // nothing to categorise — just close the sheet
      return;
    }
    // WHIT-271: the optimistic cache writes below go through patchTransactions/patchRules
    // (guarded `prev ? … : prev`), so they no-op on the cleared cache after sign-out. The late
    // FAILURE toasts have no such guard, so gate them on the session epoch — a save settling
    // after sign-out must not toast into the next session.
    const epoch = sessionEpoch.current;

    // After a categorisation persists, invalidate the server-derived caches the migrated
    // screens read. The ['budgets']/['breakdown'] invalidation is what closes the ≤45s
    // staleness (WHIT-193). The ['transactions'] FEED is deliberately NOT invalidated: it is
    // an InfiniteData of loaded pages, so invalidating would refetch every page sequentially
    // (a storm once the user has paged back). The optimistic patchTransactions above already
    // wrote the exact category change into the feed cache, and the tab reconciles the newest
    // page on focus — so a blanket feed refetch here is both redundant and costly.
    const invalidateAfterCategorise = () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      // Re-tagging a charge changes which budget's + category's cycle list it belongs to;
      // refresh the budget-detail and category drill-in lists (flat prefix → every cached list).
      queryClient.invalidateQueries({ queryKey: ['budgetTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['categoryTransactions'] });
      // WHIT-501: filing a charge changes the full-history uncategorized tally (badge/dot/empty state).
      queryClient.invalidateQueries({ queryKey: ['uncategorizedCount'] });
    };

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
      // Snapshot each affected charge's current category so a failed save reverts to what it
      // ACTUALLY was, not a blanket Uncategorized — now that the tapped charge may already be
      // categorised. Mirrors applyCategoryToMany's per-id rollback.
      const previousById = new Map(
        sameMerchantIds.map((id) => [id, transactions.find((t) => t.transaction_id === id)?.category ?? null]),
      );

      // Optimistically file all of them under the chosen category (one state update).
      patchTransactions((prev) =>
        prev.map((existing) => {
          if (!sameMerchantIds.includes(existing.transaction_id)) return existing;
          return { ...existing, category: categoryId };
        }));
      // WHIT-348: a re-file also drops the charges from any budget-detail list whose budget no
      // longer owns the new category, so the old budget's list updates before the refetch lands.
      const budgetTxSnaps = removeRefiledFromBudgetLists(categories, sameMerchantIds, categoryId);

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
      const existingRules = queryClient.getQueryData<Rule[]>(['rules']) ?? [];
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
      // call order.
      const ruleSettled = mints.length > 0
        ? Promise.allSettled(mints.map((mint) => createRule({ value: mint.value, categoryId })))
        : null;
      const { failedIds } = await persistCategoryBatch(sameMerchantIds, categoryId);
      const ruleOutcomes = ruleSettled ? await ruleSettled : [];

      // Reconcile each optimistic rule against ITS OWN temp id (allSettled preserves order, so
      // outcome i belongs to mints[i]): swap in the real BankSync id on success (so a later delete
      // targets the real rule), or remove just that temp row on failure — the others stand.
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
        // Roll back only the ones whose save failed — each to its OWN previous category
        // (WHIT-324), so a failed re-file of an already-categorised charge doesn't wrongly
        // blank it to Uncategorized.
        patchTransactions((prev) =>
          prev.map((existing) => {
            if (!failedIds.includes(existing.transaction_id)) return existing;
            return { ...existing, category: previousById.get(existing.transaction_id) ?? null };
          }));
        // WHIT-348: restore the budget lists, then re-drop only the ids that DID save — so a
        // failed re-file's row reappears while a saved one stays gone. Epoch-gated (raw
        // setQueryData recreates a cleared entry after sign-out).
        if (epoch === sessionEpoch.current) {
          budgetTxSnaps.forEach(([key, data]) => queryClient.setQueryData(key, data));
          const savedIds = sameMerchantIds.filter((id) => !failedIds.includes(id));
          if (savedIds.length > 0) removeRefiledFromBudgetLists(categories, savedIds, categoryId);
          showToast('Could not save some categories. Please try again.');
        }
      } else if (anyRuleRejected) {
        // Transactions filed fine; at least one future-rule failed to persist.
        if (epoch === sessionEpoch.current) showToast('Filed, but could not save the rule for future charges.');
      }
      // Some categorisations persisted -> refresh the bars + breakdown so spend updates
      // (old store) and invalidate the query cache (migrated screens).
      if (failedIds.length < sameMerchantIds.length) invalidateAfterCategorise();
      return;
    }

    // scope === 'one': just this single transaction.
    const previousCategory = transaction.category;
    // Optimistically show the new category on this one transaction.
    patchTransactions((prev) =>
      prev.map((existing) => {
        if (existing.transaction_id !== txId) return existing;
        return { ...existing, category: categoryId };
      }));
    // WHIT-348: drop this charge from any budget-detail list whose budget no longer owns the new
    // category, so the old budget's list updates before the refetch lands.
    const budgetTxSnaps = removeRefiledFromBudgetLists(categories, [txId], categoryId);
    showToast(`This transaction filed under ${category.name}.`);
    setSheet(null); // close the confirm sheet

    try {
      await apiSetTransactionCategory(txId, categoryId);
      invalidateAfterCategorise(); // budget bars + breakdown (old store) + query cache
    } catch {
      // Save failed — undo the optimistic change on BOTH stores, old category back.
      patchTransactions((prev) =>
        prev.map((existing) => {
          if (existing.transaction_id !== txId) return existing;
          return { ...existing, category: previousCategory };
        }));
      // WHIT-348: restore the budget lists too (raw setQueryData → epoch-gated, mirrors WHIT-344).
      if (epoch === sessionEpoch.current) {
        budgetTxSnaps.forEach(([key, data]) => queryClient.setQueryData(key, data));
        showToast('Could not save category. Please try again.');
      }
    }
  }, [sheet, showToast, patchRules, patchTransactions]);

  // WHIT-291: re-file a captured SET of transactions under one category in a single action
  // (multi-select). This is applyCategory's 'all' batch path WITHOUT the merchant rule/sweep —
  // the ids are exactly what the user selected. Optimistically patch the cache, batch-persist in
  // chunks under the server cap, then reconcile BY ID and roll back only the ones that failed to
  // their PREVIOUS category (never a blanket null — a re-filed charge may have been categorised).
  const applyCategoryToMany = useCallback(async (txIds: string[], categoryId: string): Promise<void> => {
    const transactions = readTransactionsCache();
    const categories = queryClient.getQueryData<Category[]>(['categories']) ?? [];
    const category = categories.find((c) => c.id === categoryId);
    // Only touch ids that are actually in the cache; dedupe defensively.
    const ids = Array.from(new Set(txIds)).filter((id) => transactions.some((t) => t.transaction_id === id));
    if (!category || ids.length === 0) { setSheet(null); return; }

    // Snapshot each charge's current category so a partial-failure rollback restores exactly it.
    const previousById = new Map(
      transactions.filter((t) => ids.includes(t.transaction_id)).map((t) => [t.transaction_id, t.category] as const));

    patchTransactions((prev) =>
      prev.map((existing) => (ids.includes(existing.transaction_id) ? { ...existing, category: categoryId } : existing)));
    // WHIT-348: drop the re-filed charges from any budget-detail list whose budget no longer owns
    // the new category, so the old budget's list updates before the refetch lands.
    const budgetTxSnaps = removeRefiledFromBudgetLists(categories, ids, categoryId);
    showToast(ids.length === 1
      ? `This transaction filed under ${category.name}.`
      : `${ids.length} transactions filed under ${category.name}.`);
    setSheet(null); // close the confirm sheet

    // WHIT-271: patchTransactions is guarded (no-ops on the cleared cache); gate late toasts on epoch.
    const epoch = sessionEpoch.current;

    // Batch-persist in chunks under the server cap and reconcile BY ID (shared with
    // applyCategory('all') since WHIT-292). A rejected/malformed chunk leaves its ids in
    // failedIds -> rolled back to their previous category below.
    const { failedIds } = await persistCategoryBatch(ids, categoryId);
    if (failedIds.length > 0) {
      patchTransactions((prev) =>
        prev.map((existing) => (failedIds.includes(existing.transaction_id)
          ? { ...existing, category: previousById.get(existing.transaction_id) ?? null }
          : existing)));
      // WHIT-348: restore the budget lists, then re-drop only the ids that DID save (epoch-gated).
      if (epoch === sessionEpoch.current) {
        budgetTxSnaps.forEach(([key, data]) => queryClient.setQueryData(key, data));
        const savedIds = ids.filter((id) => !failedIds.includes(id));
        if (savedIds.length > 0) removeRefiledFromBudgetLists(categories, savedIds, categoryId);
        showToast('Could not save some categories. Please try again.');
      }
    }
    // Some categorisations persisted -> refresh the server-derived Budgets/Insights reads. The
    // ['transactions'] feed is NOT invalidated (the optimistic patch already wrote the change;
    // an InfiniteData invalidate would storm every loaded page — see applyCategory above).
    if (failedIds.length < ids.length) {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      queryClient.invalidateQueries({ queryKey: ['budgetTransactions'] });
      queryClient.invalidateQueries({ queryKey: ['categoryTransactions'] });
      // WHIT-501: a batch re-file changes the full-history uncategorized tally.
      queryClient.invalidateQueries({ queryKey: ['uncategorizedCount'] });
    }
  }, [showToast, patchTransactions]);

  // WHIT-508: bring the server-derived reads back in line after an apply-rules run.
  //
  // Ordering matters. Invalidating an InfiniteData refetches EVERY loaded page sequentially (the
  // storm applyCategory documents above), and each page of the now-sparse uncategorized feed makes
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
  // `skipRules` leaves the ['rules'] cache alone. WHIT-538's fileNewRule has already prepended the
  // minted rule optimistically (with its "NEW" badge); invalidating here would refetch and reset
  // that badge to false, so it flashes then vanishes. Every other caller mints no rule (or mints
  // one it does NOT show optimistically), so they invalidate as before.
  const refreshAfterApplyRules = useCallback((opts?: { skipRules?: boolean }) => {
    queryClient.setQueryData<InfiniteData<TransactionFeedPage>>(['uncategorizedFeed'], (prev) =>
      prev && prev.pages.length > 1
        ? { ...prev, pages: prev.pages.slice(0, 1), pageParams: prev.pageParams.slice(0, 1) }
        : prev);
    queryClient.invalidateQueries({ queryKey: ['budgets'] });
    queryClient.invalidateQueries({ queryKey: ['breakdown'] });
    queryClient.invalidateQueries({ queryKey: ['budgetTransactions'] });
    queryClient.invalidateQueries({ queryKey: ['categoryTransactions'] });
    queryClient.invalidateQueries({ queryKey: ['uncategorizedCount'] });
    queryClient.invalidateQueries({ queryKey: ['uncategorizedFeed'] });
    // The reconcile writes the SERVER's category id onto the row, and a row whose id isn't in the
    // client's taxonomy still counts as unfiled (categoryIsUnmapped). So a category created in
    // another session during the run would leave its charges sitting in the Uncategorized list
    // while the badge dropped — list and badge disagreeing. Re-read the taxonomy too.
    queryClient.invalidateQueries({ queryKey: ['categories'] });
    // WHIT-517: a rule sweep files charges (shrinking the shop groups) and — for "file by shop" —
    // mints a rule. Refresh the "file by shop" list so a filed shop leaves it, and the rules list
    // so a minted rule appears. Harmless (and correct) for plain "Apply my rules" too, which also
    // shrinks the groups.
    if (!opts?.skipRules) queryClient.invalidateQueries({ queryKey: ['rules'] });
    queryClient.invalidateQueries({ queryKey: ['uncategorizedMerchants'] });
  }, []);

  // WHIT-508: preview what the user's existing rules would file, writing nothing. Lives here
  // rather than in the sheet so the component never imports the api layer directly: it keeps the
  // `../api` mock seam every screen test relies on, and it gets the same session-epoch bail every
  // other awaited call has — a preview landing after a sign-out must not paint the next session.
  const previewRuleApplication = useCallback(async (): Promise<ApplyRulesResult | null> => {
    const epoch = sessionEpoch.current;
    try {
      const result = await applyRulesToUncategorized(true);
      if (epoch !== sessionEpoch.current) return null;
      return result;
    } catch {
      return null; // a preview writes nothing, so there is nothing to reconcile
    }
  }, []);

  // WHIT-508: file every charge the rules cover. The server has already committed by the time it
  // answers and tells us exactly which rows landed, so — unlike applyCategory/applyCategoryToMany
  // — there is no optimistic write, no previous-category snapshot and no rollback to build.
  // Returns the server's own report (null on failure) so the sheet can offer "Apply the rest"
  // after a capped run without paying for a second whole-history preview.
  const applyRulesToHistory = useCallback(async (): Promise<ApplyRulesResult | null> => {
    // The latch lives HERE, not in the sheet: dismissing the sheet mid-write unmounts it, and
    // reopening would otherwise mint a fresh component latch and let a second 300-write run start
    // on top of the first. The provider outlives the sheet, so one run at a time really means one.
    if (applyRulesInFlight.current || applyRulesJobActive.current) return null;
    applyRulesInFlight.current = true;
    const epoch = sessionEpoch.current;
    try {
      const result = await applyRulesToUncategorized(false);
      if (epoch !== sessionEpoch.current) return null; // signed out mid-flight

      const filedBy = new Map(result.filed.map((row) => [row.id, row.category]));
      const vanished = new Set(result.vanished);
      if (filedBy.size > 0 || vanished.size > 0) {
        // One pass over all three list caches. A filed row stops matching the Uncategorized tab's
        // client re-filter and disappears instantly; a vanished row is gone server-side, so leaving
        // it would show a phantom charge until the next refetch.
        // Deliberately NOT touching `alreadyFiled`: unlike `vanished`, those rows still exist and
        // now carry the category the user just chose. Dropping them would delete a charge they can
        // see, and the invalidation below does not bring the general feed back.
        patchTransactions((prev) => prev
          .filter((existing) => !vanished.has(existing.transaction_id))
          .map((existing) => (filedBy.has(existing.transaction_id)
            ? { ...existing, category: filedBy.get(existing.transaction_id)! }
            : existing)));
      }
      refreshAfterApplyRules();
      return result;
    } catch {
      if (epoch !== sessionEpoch.current) return null;
      // The outcome is UNKNOWN, not "nothing happened": the server writes row by row and only
      // reports at the end, so an abort, a dropped connection or a late 5xx can leave up to
      // APPLY_RULES_MAX_WRITES charges filed. The count has a 5-minute staleTime, so without this
      // the badge, tab list and budgets would keep the old numbers until a manual pull. Refresh
      // and let the sheet say the outcome is uncertain.
      refreshAfterApplyRules();
      return null;
    } finally {
      applyRulesInFlight.current = false;
    }
  }, [patchTransactions, refreshAfterApplyRules]);

  // WHIT-517: preview one shop's file-by-shop run — mint-and-file with dryRun, writing nothing —
  // so the confirm sheet can show the count + overlap before she commits. A 409 (an existing rule
  // would fight this one) is kept DISTINCT from a generic failure so the sheet can explain it; the
  // server runs its clash check before the dry-run branch, so a clash surfaces even here.
  const previewFileByShop = useCallback(
    async (group: UncategorizedMerchantGroup, categoryId: string): Promise<FileByShopOutcome> => {
      const epoch = sessionEpoch.current;
      try {
        const report = await applyRulesToUncategorized(true, { value: group.rulePattern, categoryId });
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        return { ok: true, report };
      } catch (e) {
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        return { ok: false, clash: e instanceof ApiError && e.status === 409 ? e : null };
      }
    }, []);

  // WHIT-517: file one shop — mint the rule AND file that shop's stored charges in one call. Shares
  // applyRulesInFlight with applyRulesToHistory, so "Apply my rules" and "File by shop" can never
  // run at once. A 409 clash returns { clash } and writes/refreshes NOTHING (the server minted
  // nothing). Unlike applyRulesToHistory, this does NOT collapse the 409 to a bare null.
  const fileByShop = useCallback(
    async (group: UncategorizedMerchantGroup, categoryId: string): Promise<FileByShopOutcome> => {
      if (applyRulesInFlight.current || applyRulesJobActive.current) return { ok: false, clash: null };
      applyRulesInFlight.current = true;
      const epoch = sessionEpoch.current;
      try {
        const report = await applyRulesToUncategorized(false, { value: group.rulePattern, categoryId });
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };

        const filedBy = new Map(report.filed.map((row) => [row.id, row.category]));
        const vanished = new Set(report.vanished);
        if (filedBy.size > 0 || vanished.size > 0) {
          patchTransactions((prev) => prev
            .filter((existing) => !vanished.has(existing.transaction_id))
            .map((existing) => (filedBy.has(existing.transaction_id)
              ? { ...existing, category: filedBy.get(existing.transaction_id)! }
              : existing)));
        }
        refreshAfterApplyRules();
        return { ok: true, report };
      } catch (e) {
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        // A 409 clash wrote nothing — surface it, refresh nothing. Any other error has an unknown
        // outcome (row-by-row writes, late failure), so refresh like applyRulesToHistory does.
        if (e instanceof ApiError && e.status === 409) return { ok: false, clash: e };
        refreshAfterApplyRules();
        return { ok: false, clash: null };
      } finally {
        applyRulesInFlight.current = false;
      }
    }, [patchTransactions, refreshAfterApplyRules]);

  // WHIT-538: dry-run the typed pattern before the rule exists, so the add-rule confirm sheet can
  // show how many stored charges it would file. Mirrors previewFileByShop but takes the raw pattern
  // (a shop passes its precomputed rulePattern; here the user typed it). Writes nothing.
  const previewNewRule = useCallback(
    async (pattern: string, categoryId: string, budgetExcluded = false): Promise<FileByShopOutcome> => {
      const epoch = sessionEpoch.current;
      try {
        const report = await applyRulesToUncategorized(true, { value: pattern.trim(), categoryId, budgetExcluded });
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        return { ok: true, report };
      } catch (e) {
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        return { ok: false, clash: e instanceof ApiError && e.status === 409 ? e : null };
      }
    }, []);

  // WHIT-538: mint the typed rule AND file the stored charges it catches, in one call. Mirrors
  // fileByShop (shared applyRulesInFlight guard, same filed/vanished patch, same 409-clash outcome),
  // with one addition: the user is on the Rules screen, so the minted rule (returned as createdRule)
  // is prepended to the ['rules'] cache with its "NEW" badge and the refresh SKIPS re-fetching rules,
  // so the badge survives. When the server omits createdRule (older build), fall back to the normal
  // refresh so the rule still lands in the list on refetch.
  const fileNewRule = useCallback(
    async (pattern: string, categoryId: string, budgetExcluded = false): Promise<FileByShopOutcome> => {
      if (applyRulesInFlight.current || applyRulesJobActive.current) return { ok: false, clash: null };
      applyRulesInFlight.current = true;
      const epoch = sessionEpoch.current;
      try {
        const report = await applyRulesToUncategorized(false, { value: pattern.trim(), categoryId, budgetExcluded });
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };

        const filedBy = new Map(report.filed.map((row) => [row.id, row.category]));
        const vanished = new Set(report.vanished);
        if (filedBy.size > 0 || vanished.size > 0) {
          patchTransactions((prev) => prev
            .filter((existing) => !vanished.has(existing.transaction_id))
            .map((existing) => (filedBy.has(existing.transaction_id)
              ? { ...existing, category: filedBy.get(existing.transaction_id)! }
              : existing)));
        }
        if (report.createdRule) {
          const minted = report.createdRule;
          patchRules((prev) => [{ ...toRule(minted as RuleRecord), isNew: true }, ...prev]);
          refreshAfterApplyRules({ skipRules: true });
        } else {
          refreshAfterApplyRules();
        }
        return { ok: true, report };
      } catch (e) {
        if (epoch !== sessionEpoch.current) return { ok: false, clash: null };
        if (e instanceof ApiError && e.status === 409) return { ok: false, clash: e };
        refreshAfterApplyRules();
        return { ok: false, clash: null };
      } finally {
        applyRulesInFlight.current = false;
      }
    }, [patchTransactions, patchRules, refreshAfterApplyRules]);

  // WHIT-560: async apply-rules background job. Stop the poll timer and release the "one run at a
  // time" lock. Does NOT clear `applyRulesJob` state — a terminal frame stays on screen; the
  // dismiss effect drops it when the sheet closes.
  const endApplyRulesJob = useCallback(() => {
    stopApplyRulesPolling();
    applyRulesJobId.current = null;
    applyRulesNetErrors.current = 0;
    applyRulesJobActive.current = false;
  }, [stopApplyRulesPolling]);

  // A terminal job (server `status` succeeded/failed): end polling, then reconcile the caches. The
  // async path can only INVALIDATE (the GET returns counts, not id lists — so no per-row patch like
  // the sync writers). A failed job may still have filed some rows before dying, so it refreshes
  // too. The "add rule" variant prepends the minted rule with its NEW badge (skipping the rules
  // refetch), exactly like fileNewRule; every other variant refreshes rules normally.
  const finishApplyRulesJob = useCallback((job: ApplyRulesJob) => {
    endApplyRulesJob();
    setApplyRulesJob(job);
    if (job.status === 'succeeded' && job.createdRule && applyRulesJobPrependRule.current) {
      const minted = job.createdRule;
      patchRules((prev) => [{ ...toRule(minted as RuleRecord), isNew: true }, ...prev]);
      refreshAfterApplyRules({ skipRules: true });
    } else {
      refreshAfterApplyRules();
    }
  }, [endApplyRulesJob, patchRules, refreshAfterApplyRules]);

  // The job stopped without a server verdict — an expired/unknown id (404) or too many consecutive
  // network drops. Mark the last-known frame failed (so the sheet shows the failed arm + retry) and
  // still refresh, since a lost-contact job may have landed rows server-side.
  const failApplyRulesJob = useCallback((error: string) => {
    endApplyRulesJob();
    setApplyRulesJob((prev) => (prev ? { ...prev, status: 'failed', error } : prev));
    refreshAfterApplyRules();
  }, [endApplyRulesJob, refreshAfterApplyRules]);

  // One poll of the running job, self-scheduling: it arms the NEXT poll only after this one settles,
  // so polls never overlap. Bails silently if the job was torn down (id cleared) or the session
  // changed under it. A thrown fetch (offline) is swallowed and retried up to the net-error cap; only
  // a server `status` or a 404 ends the job.
  const pollApplyRulesJob = useCallback(async () => {
    const jobId = applyRulesJobId.current;
    if (!jobId) return;
    const startEpoch = applyRulesJobStartEpoch.current;
    const gen = applyRulesPollGen.current;
    // A teardown (dismiss/lock/sign-out/terminal) between this poll firing and its GET resolving
    // bumps the generation — this poll must then NOT re-arm the timer, or it would revive a stopped
    // loop (and race the reopen effect into two live chains).
    const superseded = () => applyRulesJobId.current !== jobId
      || startEpoch !== sessionEpoch.current || gen !== applyRulesPollGen.current;
    try {
      const job = await apiGetApplyRulesJob(jobId);
      if (superseded()) return;
      applyRulesNetErrors.current = 0;
      if (job.status === 'running') {
        setApplyRulesJob(job);
        applyRulesPollTimer.current = setTimeout(() => applyRulesPollRef.current(), APPLY_RULES_JOB_POLL_DELAY_MS);
        return;
      }
      finishApplyRulesJob(job); // succeeded or failed — terminal
    } catch (e) {
      if (superseded()) return;
      if (e instanceof ApiError && e.status === 404) { failApplyRulesJob('expired'); return; }
      applyRulesNetErrors.current += 1;
      if (applyRulesNetErrors.current >= APPLY_RULES_JOB_MAX_NET_ERRORS) { failApplyRulesJob('network'); return; }
      applyRulesPollTimer.current = setTimeout(() => applyRulesPollRef.current(), APPLY_RULES_JOB_POLL_DELAY_MS);
    }
  }, [finishApplyRulesJob, failApplyRulesJob]);
  useEffect(() => { applyRulesPollRef.current = pollApplyRulesJob; }, [pollApplyRulesJob]);

  // Start a background job (the plain sweep passes no rule; the inline variants pass one). Blocks if
  // any apply-rules run — sync OR a still-active async job — is already going. On the accepted 202 it
  // records the id, shows the first `running` frame, and arms the poll loop. A 409 surfaces as a
  // clash for the confirm sheets; a 400/502 is a generic "couldn't start". `prependRule` is set only
  // for the "add rule" variant so its success prepends the minted rule (see finishApplyRulesJob).
  const beginApplyRulesJob = useCallback(async (
    rule: { value: string; categoryId: string; budgetExcluded?: boolean } | undefined,
    prependRule: boolean,
  ): Promise<ApplyRulesJobStart> => {
    if (applyRulesInFlight.current || applyRulesJobActive.current) return { ok: false, clash: null };
    applyRulesJobActive.current = true;
    applyRulesJobStartEpoch.current = sessionEpoch.current;
    applyRulesJobPrependRule.current = prependRule;
    // Remember THIS run's variant, so "Try again" restarts the SAME sweep. `applyRulesJob` is global,
    // so a failed job can be shown (and retried) from a different sheet than the one that started it.
    applyRulesJobRetryArgs.current = { rule, prependRule };
    applyRulesNetErrors.current = 0;
    try {
      const job = await apiStartApplyRulesJob(rule);
      // A teardown during the POST wins. Sign-out bumps sessionEpoch; a Face-ID lock does NOT — it
      // only flips applyRulesJobActive false (context lock effect). Checking BOTH means a lock (or
      // sign-out) mid-POST discards this start instead of resurrecting a job the teardown just
      // cleared and leaving a poll loop live with the lock released.
      if (!applyRulesJobActive.current || applyRulesJobStartEpoch.current !== sessionEpoch.current) {
        applyRulesJobActive.current = false;
        return { ok: false, clash: null };
      }
      applyRulesJobId.current = job.jobId;
      setApplyRulesJob(job);
      applyRulesPollTimer.current = setTimeout(() => applyRulesPollRef.current(), APPLY_RULES_JOB_POLL_DELAY_MS);
      return { ok: true };
    } catch (e) {
      applyRulesJobActive.current = false;
      if (applyRulesJobStartEpoch.current !== sessionEpoch.current) return { ok: false, clash: null };
      return { ok: false, clash: e instanceof ApiError && e.status === 409 ? e : null };
    }
  }, []);

  const startApplyRulesSweep = useCallback(() => beginApplyRulesJob(undefined, false), [beginApplyRulesJob]);
  const startFileByShopJob = useCallback(
    (group: UncategorizedMerchantGroup, categoryId: string) =>
      beginApplyRulesJob({ value: group.rulePattern, categoryId }, false), [beginApplyRulesJob]);
  const startNewRuleJob = useCallback(
    (pattern: string, categoryId: string, budgetExcluded = false) =>
      beginApplyRulesJob({ value: pattern.trim(), categoryId, budgetExcluded }, true), [beginApplyRulesJob]);
  // "Try again" on a failed job re-runs the ORIGINAL variant (sweep / file-this-shop / add-rule),
  // whichever started it — never a plain sweep by default. The three sheets all call this.
  const retryApplyRulesJob = useCallback((): Promise<ApplyRulesJobStart> => {
    const a = applyRulesJobRetryArgs.current;
    return a ? beginApplyRulesJob(a.rule, a.prependRule) : Promise.resolve({ ok: false, clash: null });
  }, [beginApplyRulesJob]);

  // WHIT-275: edit one transaction's note and/or tags, mirroring applyCategory's
  // single-transaction path — snapshot the current values, optimistically patch the
  // ['transactions'] cache the detail screen reads, persist, and roll back on failure.
  // `patch` carries only the fields being changed, so a note edit never clobbers tags
  // (and vice-versa); a passed "" note / [] tags clears that field on the server.
  const applyTransactionEdit = useCallback(
    async (txId: string, patch: { notes?: string; tags?: string[]; budget_excluded?: boolean }): Promise<void> => {
      // The budget-detail + Insights category-drill lists live in their own per-category (and
      // per-cycle) caches, NOT in readTransactionsCache's feed/uncat/recent union. A charge
      // opened from one of those lists that lives ONLY there (an older one-off, off the recent
      // window) would otherwise not be found here and the edit would silently no-op. Scan those
      // caches ONLY for this lookup — kept local to this edit so applyCategory's re-file sweep,
      // which shares readTransactionsCache, never sees a stale cycle-keyed row (WHIT-524).
      const findInScopedLists = (id: string): Transaction | undefined => {
        for (const prefix of [['budgetTransactions'], ['categoryTransactions']] as const) {
          for (const [, data] of queryClient.getQueriesData<Transaction[]>({ queryKey: prefix })) {
            const hit = data?.find((t) => t.transaction_id === id);
            if (hit) return hit;
          }
        }
        return undefined;
      };
      // Stamp `fields` onto this txId wherever it appears; leave other rows untouched.
      const stamp = (fields: Partial<Transaction>) => (row: Transaction) =>
        (row.transaction_id === txId ? { ...row, ...fields } : row);
      // Map `stamp` over each cache under the given key prefixes, in place. Guarded (no-ops on a
      // cleared cache), so — like patchTransactions — the rollback below needs no epoch gate.
      const patchScopedLists = (prefixes: readonly (readonly string[])[], mapRow: (t: Transaction) => Transaction) => {
        for (const prefix of prefixes) {
          for (const [key] of queryClient.getQueriesData<Transaction[]>({ queryKey: prefix })) {
            queryClient.setQueryData<Transaction[]>(key, (prev) => (prev ? prev.map(mapRow) : prev));
          }
        }
      };
      const BUDGET_AND_CATEGORY = [['budgetTransactions'], ['categoryTransactions']] as const;

      const transaction =
        readTransactionsCache().find((t) => t.transaction_id === txId) ?? findInScopedLists(txId);
      if (!transaction) return; // cache evicted / unknown id — nothing to edit

      // Snapshot only the fields we're about to change, so a failed save restores
      // exactly them (undefined restores an absent field, not an empty value).
      const previous: { notes?: string; tags?: string[]; budget_excluded?: boolean } = {};
      if ('notes' in patch) previous.notes = transaction.notes;
      if ('tags' in patch) previous.tags = transaction.tags;
      if ('budget_excluded' in patch) previous.budget_excluded = transaction.budget_excluded;

      patchTransactions((prev) =>
        prev.map((existing) => (existing.transaction_id === txId ? { ...existing, ...patch } : existing)));

      // WHIT-525: stamp the row in BOTH scoped caches (budget + category) uniformly. The old
      // approach (WHIT-344) removed the row from budgetTransactions, which blanked a budget-only
      // charge's detail screen to "not found." Now the row stays findable; budgetDetail filters
      // out excluded rows at the view-model level so the budget list still drops them visually.
      // Re-including (budget_excluded: false) still relies on the invalidate (no optimistic add).
      patchScopedLists(BUDGET_AND_CATEGORY, stamp(patch));

      // WHIT-271: patchTransactions is guarded (no-ops on the cleared cache); gate the late
      // failure toast on the epoch so a save settling after sign-out doesn't toast the next session.
      const epoch = sessionEpoch.current;
      try {
        await apiSetTransactionFields(txId, patch);
        // The ['transactions'] feed is NOT invalidated: the optimistic patchTransactions above
        // already wrote notes/tags/budget_excluded into the feed cache, and an InfiniteData
        // invalidate would refetch every loaded page (a storm once paged back).
        // Excluding/including a charge changes the budget total AND its cycle list — refresh
        // both together so the detail header and its rows stay reconciled (a note/tag edit
        // touches neither, so only do this for a budget_excluded change).
        if ('budget_excluded' in patch) {
          queryClient.invalidateQueries({ queryKey: ['budgets'] });
          queryClient.invalidateQueries({ queryKey: ['breakdown'] });
          queryClient.invalidateQueries({ queryKey: ['budgetTransactions'] });
          queryClient.invalidateQueries({ queryKey: ['categoryTransactions'] });
        }
      } catch {
        patchTransactions((prev) =>
          prev.map((existing) => (existing.transaction_id === txId ? { ...existing, ...previous } : existing)));
        patchScopedLists(BUDGET_AND_CATEGORY, stamp(previous));
        if (epoch === sessionEpoch.current) {
          showToast('Could not save. Please try again.');
        }
      }
    },
    [patchTransactions, showToast],
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
      const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
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
        .getQueriesData<Record<string, BudgetRollup>>({ queryKey: ['budgets'] })
        .some(([, data]) => !!data && (data[categoryId]?.target ?? 0) > 0);
      // WHIT-271: `c` (category name) + `saved.target` (dollar figure) are the OLD session's
      // data — if the user signs out during the round-trip this success toast would render
      // them to the next signed-in user. Gate every post-await toast on the session epoch.
      const epoch = sessionEpoch.current;
      try {
        // Pass rollover only when the caller supplied it — a plain amount save (no rollover
        // arg) leaves the stored flag untouched, so the API omits it from the body.
        const saved = rollover === undefined
          ? await apiSetBudget(categoryId, value)
          : await apiSetBudget(categoryId, value, rollover);
        // WHIT-271: return false (not just skip the toast) so app/budget/edit.tsx's `if (ok)`
        // doesn't invalidate + navigate the NEXT session after a mid-save sign-out.
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        // The Budgets screen reads ['budgets'] and app/budget/edit.tsx invalidates it after
        // this returns true, so the just-saved target reconciles from the server rollup —
        // no optimistic cache write needed here.
        if (c) showToast(`${c.name} budget ${existing ? 'updated' : 'set'} to ${fmt(saved.target)}.`);
        return true;
      } catch {
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        showToast('Could not save budget. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  // WHIT-505: spread a one-off bill over the coming cycles. Non-optimistic — invalidates
  // ['budgets'] here so the plan reconciles from the server rollup (self-contained, matching
  // removeSpread below; the caller just navigates). The category name (for the toast) comes
  // from the ['categories'] cache; every post-await toast/return is gated on the session epoch
  // (WHIT-271) so a mid-save sign-out never toasts into or navigates the next user's session.
  const saveSpread = useCallback(
    async (categoryId: string, amount: number, cycles: number): Promise<boolean> => {
      if (amount <= 0 || cycles < SPREAD_MIN_CYCLES || cycles > SPREAD_MAX_CYCLES) return false;
      const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
      const epoch = sessionEpoch.current;
      try {
        await apiSetSpread(categoryId, amount, cycles);
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        queryClient.invalidateQueries({ queryKey: ['budgets'] });
        if (c) showToast(`Bill spread set for ${c.name}.`);
        return true;
      } catch {
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        showToast('Could not set the bill spread. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  // WHIT-505: remove a category's bill spread. Non-optimistic (invalidate + refetch), matching
  // saveSpread beside it — the writer touches the query cache, never screen state, so a popped
  // screen can't setState-after-unmount. Idempotent server-side (200 with no plan).
  const removeSpread = useCallback(
    async (categoryId: string): Promise<boolean> => {
      const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
      const epoch = sessionEpoch.current;
      try {
        await apiDeleteSpread(categoryId);
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        queryClient.invalidateQueries({ queryKey: ['budgets'] });
        if (c) showToast(`Bill spread removed for ${c.name}.`);
        return true;
      } catch {
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        showToast('Could not remove the bill spread. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  // WHIT-203: remove a category's budget target (the Budget detail screen's Delete). The
  // category and its transactions are untouched — only the pay-cycle target is dropped, so
  // the category simply stops appearing on the Budgets tab. Optimistically strips the id from
  // every ['budgets', cycleLen] cache entry (a Record keyed by id — the raw queryFn output the
  // Budgets screen reads), rolling the snapshots back on failure, then invalidates to reconcile
  // with the server rollup.
  const deleteBudget = useCallback(
    async (categoryId: string): Promise<boolean> => {
      const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
      // Snapshot every ['budgets'] entry so a failure can restore exactly what was there.
      const snapshots = queryClient.getQueriesData<Record<string, BudgetRollup>>({ queryKey: ['budgets'] });
      snapshots.forEach(([key, data]) => {
        if (!data || !(categoryId in data)) return;
        const { [categoryId]: _removed, ...rest } = data;
        queryClient.setQueryData<Record<string, BudgetRollup>>(key, rest);
      });
      // WHIT-271: a failure settling after sign-out must not restore stale rollups into the
      // cleared cache, nor toast into the next session.
      const epoch = sessionEpoch.current;
      try {
        await apiDeleteBudget(categoryId);
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        queryClient.invalidateQueries({ queryKey: ['budgets'] });
        if (c) showToast(`${c.name} budget removed.`);
        return true;
      } catch {
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        snapshots.forEach(([key, data]) => queryClient.setQueryData(key, data));
        showToast('Could not remove budget. Please try again.');
        return false;
      }
    },
    [showToast],
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
      // WHIT-271: the cache write below is guarded (`prev ? … : prev`), so it no-ops after
      // sign-out; gate the toast on the epoch so a late create doesn't toast the next session.
      const epoch = sessionEpoch.current;
      try {
        const created = toCategory(await createCategory(input));
        // WHIT-271: return null (not just skip the toast) so callers (the categorise sheet's
        // createAndFile, app/category/edit.tsx) don't act on it after a mid-save sign-out. The
        // append is also NON-id-keyed, so it would plant this category into the next session's list.
        if (epoch !== sessionEpoch.current) return null; // signed out mid-flight
        queryClient.setQueryData<Category[]>(['categories'], (prev) => (prev ? [...prev, created] : prev));
        queryClient.invalidateQueries({ queryKey: ['categories'] });
        if (!opts?.silent) showToast('Category created.');
        return created;
      } catch (error) {
        // WHIT-271/282: a session change mid-flight is not a failure to report — neither toast
        // nor throw; the caller's own epoch check owns the bail.
        if (epoch !== sessionEpoch.current) return null;
        // WHIT-437: `silent` means "I don't toast" — so hand the caller the error to speak with.
        // app/category/edit.tsx folds the reason into its one summary toast.
        if (opts?.silent) throw error;
        showToast(writeFailureMessage(error, 'Could not save category. Please try again.'));
        return null;
      }
    },
    [showToast],
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
      // WHIT-271: guarded cache write no-ops after sign-out; gate the toast on the epoch.
      const epoch = sessionEpoch.current;
      try {
        const updated = await updateCategory(editId, input);
        // WHIT-271: return false (not just skip the toast) so app/category/edit.tsx doesn't run
        // its summary toast + router.back() after a mid-save sign-out.
        if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
        queryClient.setQueryData<Category[]>(['categories'], (prev) => (prev ? prev.map((c) => (c.id === editId ? toCategory(updated) : c)) : prev));
        // WHIT-203: the setQueryData shows the change instantly on the migrated screens /
        // pickers; the invalidate then reconciles with the server.
        queryClient.invalidateQueries({ queryKey: ['categories'] });
        if (!opts?.silent) showToast('Category updated.');
        return true;
      } catch (error) {
        if (epoch !== sessionEpoch.current) return false;   // WHIT-271/282, as above
        if (opts?.silent) throw error;                      // WHIT-437, as above
        showToast(writeFailureMessage(error, 'Could not save category. Please try again.'));
        return false;
      }
    },
    [showToast, createCategoryInline],
  );

  const deleteCategory = useCallback(async (id: string): Promise<boolean> => {
    // WHIT-271: the cascade cache writes below are all guarded (`prev?.` / patchRules), so they
    // no-op after sign-out; gate the toasts on the epoch so a late delete doesn't toast the next session.
    const epoch = sessionEpoch.current;
    try {
      await apiDeleteCategory(id);
      // Client-side cascade into the query caches the migrated screens read (category
      // list, budget screens, tab badge, pickers). setQueryData — NOT invalidate —
      // because the server does no cascade, so a refetch would resurrect the just-dropped
      // budget/rule/txn-tag (cosmetic: those txns re-appear with the dangling id and
      // render as Uncategorized via isUncategorized). The ['budgets'] cache holds the RAW
      // Record<categoryId, BudgetRollup> (not the select'd Budget[]), so drop the deleted
      // id's KEY from the Record via setQueriesData (prefix ['budgets']) — filtering it as
      // an array would throw `.filter is not a function` and abort the rest of the cascade.
      // Rules go through patchRules (same ['rules'] cache).
      queryClient.setQueryData<Category[]>(['categories'], (prev) => prev?.filter((c) => c.id !== id));
      queryClient.setQueriesData<Record<string, BudgetRollup>>({ queryKey: ['budgets'] }, (prev) => {
        if (!prev || !(id in prev)) return prev;
        const { [id]: _removed, ...rest } = prev;
        return rest;
      });
      patchRules((prev) => prev.filter((r) => r.categoryId !== id));
      patchTransactionsCache((prev) => prev.map((t) => (t.category === id ? { ...t, category: null } : t)));
      // The deleted category's in-cycle spend now falls into Uncategorized on the
      // breakdown; invalidate so the Insights tab re-pulls and reflects that.
      queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      // WHIT-501: the deleted category's charges just became uncategorized (patched to null
      // above, and the id dropped from the server's taxonomy), so the full-history tally rose.
      // Invalidate (not setQueryData) — the server count genuinely changed, so a refetch is truth.
      queryClient.invalidateQueries({ queryKey: ['uncategorizedCount'] });
      // Those charges must also ENTER the Uncategorized tab's list. The patch above only cleared
      // the category on rows already in a cache; the uncategorized feed is a separate paged query
      // that must re-fetch to include them. Unlike a single categorise (where an in-place patch
      // suffices, so the frequent path avoids an InfiniteData refetch storm), deleting a category
      // is rare, so invalidating the paged feed here is cheap and keeps the list correct.
      queryClient.invalidateQueries({ queryKey: ['uncategorizedFeed'] });
      // WHIT-271: return false (not just skip the toast) so app/category/edit.tsx's `if (ok)`
      // doesn't router.back() the next session after a mid-delete sign-out.
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      showToast('Category deleted.');
      return true;
    } catch (error) {
      if (epoch === sessionEpoch.current)
        showToast(writeFailureMessage(error, 'Could not delete category. Please try again.'));
      return false;
    }
  }, [showToast, patchRules]);

  // Optimistically remove the rule, then delete it in BankSync; on failure put it back in
  // front of the row that followed it (WHIT-254 — a saved index would misplace it when two
  // deletes fail at once) and tell the user. A temp-id rule (mid-create) deletes fine too —
  // the server DELETE is idempotent (unknown id -> 200), and a refresh reconciles any brief
  // create/delete race.
  const deleteRule = useCallback(async (id: string) => {
    // WHIT-192: source the rules snapshot (for the rollback) from the ['rules'] query cache
    // the screen reads, not a store useState.
    const current = queryClient.getQueryData<Rule[]>(['rules']) ?? [];
    const index = current.findIndex((r) => r.id === id);
    if (index === -1) return;
    const removed = current[index];
    const successorIds = current.slice(index + 1).map((r) => r.id);
    patchRules((prev) => prev.filter((r) => r.id !== id));
    // WHIT-271: patchRules is guarded (no-ops on the evicted cache); gate the toast on the epoch.
    const epoch = sessionEpoch.current;
    // WHIT-540: deleting a rule now UNDOES the fills it left on stored charges (the server clears
    // them back to unfiled), so the server-derived reads DO move — refresh the count, feed, budgets
    // and merchant groups. `skipRules` leaves the ['rules'] cache alone: the optimistic removal
    // above already dropped this rule, and a refetch would just race that.
    try {
      await apiDeleteRule(id);
      if (epoch === sessionEpoch.current) refreshAfterApplyRules({ skipRules: true });
    } catch {
      // WHIT-271: guard the CACHE write too, not just the toast — reinsertBefore appends the rule
      // when its successorIds aren't found, so on the NEXT session's repopulated ['rules'] cache
      // (patchRules only no-ops on the CLEARED cache) it would plant this rule into that account.
      if (epoch !== sessionEpoch.current) return; // signed out mid-flight
      patchRules((prev) => reinsertBefore(prev, removed, successorIds));
      showToast('Could not delete rule. Please try again.');
    }
  }, [showToast, patchRules, refreshAfterApplyRules]);

  // Optimistically add the rule (temp id), create it in BankSync, then swap in the
  // real id — or remove it and warn on failure. Value is sent as typed (trimmed,
  // not upper-cased) so both rule-creation paths POST a consistent `value`.
  const saveManualRule = useCallback(async (pattern: string, categoryId: string, budgetExcluded = false, write?: RuleWrite) => {
    // WHIT-563: a multi-condition rule has no single pattern — its stored value is the first
    // condition's value (what the server derives too), so both paths key the optimistic row + toast
    // off `value`.
    const value = write ? write.conditions[0].value : pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: the toast copy needs the category name — sourced from the ['categories']
    // query cache the screens read, not a store useState.
    const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
    const tempRuleId = 'tmp-' + Date.now();
    const optimistic: Rule = write
      ? { id: tempRuleId, pattern: value, categoryId, isNew: true, budgetExcluded, field: write.conditions[0].field, operator: write.conditions[0].operator, conditions: write.conditions, logic: write.logic }
      : { id: tempRuleId, pattern: value, categoryId, isNew: true, budgetExcluded };
    patchRules((prev) => [optimistic, ...prev]);
    setSheet(null);
    // WHIT-563: a multi-condition rule's `value` is just the first condition's raw value (an
    // account id or a direction token for those fields), so it isn't shown — the toast names the
    // category only. A classic single rule still quotes its readable pattern.
    if (c) showToast(write ? `Rule added — files as ${c.name}.` : `Rule added — ${value} files as ${c.name}.`);
    // WHIT-271: the success toast above is pre-await (safe); gate the late failure toast on the epoch.
    const epoch = sessionEpoch.current;
    // WHIT-502: a new rule only files FUTURE charges (the webhook applies rules as charges land); no stored
    // charge changes category here, so ['uncategorizedCount'] is intentionally NOT invalidated. Any later
    // bank-side re-tag arrives via the webhook, already covered by the count's staleTime + pull-to-refresh.
    try {
      const created = await createRule(write ? { conditions: write.conditions, logic: write.logic, categoryId, budgetExcluded } : { value, categoryId, budgetExcluded });
      // Keep isNew so the "NEW" badge survives settlement (toRule defaults it
      // false for the load path, where rules genuinely aren't new).
      patchRules((prev) => prev.map((r) => (r.id === tempRuleId ? { ...toRule(created), isNew: true } : r)));
    } catch {
      patchRules((prev) => prev.filter((r) => r.id !== tempRuleId));
      if (epoch === sessionEpoch.current) showToast('Could not save rule. Please try again.');
    }
  }, [showToast, patchRules]);

  // Optimistically edit a rule in place, then PUT it; roll back to the snapshot on
  // failure. The rule's field/operator are preserved (passed through) so a
  // non-default rule isn't silently reset to description/contains.
  const updateRule = useCallback(async (id: string, pattern: string, categoryId: string, budgetExcluded = false, write?: RuleWrite) => {
    const value = write ? write.conditions[0].value : pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: source the `before` snapshot (for rollback) + the category name from the
    // query caches the screens read, not store useStates.
    const before = queryClient.getQueryData<Rule[]>(['rules'])?.find((r) => r.id === id);
    if (!before) return;
    // WHIT-563: carry conditions/logic on a multi edit; explicitly null them on a classic edit so an
    // edit that reduces a multi rule to one condition doesn't leave stale rows on the optimistic copy
    // (the server settle replaces the row wholesale, but the interim must be consistent too).
    const patch = write
      ? { pattern: value, categoryId, budgetExcluded, field: write.conditions[0].field, operator: write.conditions[0].operator, conditions: write.conditions, logic: write.logic }
      : { pattern: value, categoryId, budgetExcluded, conditions: null, logic: null };
    patchRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setSheet(null);
    const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
    if (c) showToast(write ? `Rule updated — files as ${c.name}.` : `Rule updated — ${value} files as ${c.name}.`);
    // WHIT-271: the success toast above is pre-await (safe); gate the late failure toast on the epoch.
    const epoch = sessionEpoch.current;
    // WHIT-540: editing a rule now RE-FILES the stored charges it already touched (the server moves
    // them to the new target, or clears the ones the edit no longer matches), so the server-derived
    // reads DO move — refresh the count, feed, budgets and merchant groups. `skipRules` leaves the
    // ['rules'] cache alone: the optimistic edit above already patched this rule's row.
    try {
      const saved = await apiUpdateRule(id, write
        ? { conditions: write.conditions, logic: write.logic, categoryId, budgetExcluded }
        : { value, categoryId, field: before.field, operator: before.operator, budgetExcluded });
      patchRules((prev) => prev.map((r) => (r.id === id ? { ...toRule(saved), isNew: r.isNew } : r)));
      if (epoch === sessionEpoch.current) refreshAfterApplyRules({ skipRules: true });
    } catch {
      patchRules((prev) => prev.map((r) => (r.id === id ? before : r)));
      if (epoch === sessionEpoch.current) showToast('Could not update rule. Please try again.');
    }
  }, [showToast, patchRules, refreshAfterApplyRules]);

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
    const before = queryClient.getQueryData<GoalRecord[]>(['goals'])?.find((g) => g.id === id) ?? null;
    // Checkpoints need their permanent ids BEFORE the optimistic row lands in the cache: a
    // GoalRecord promises every checkpoint has one, and the celebration keys on it. Mint any
    // missing id here (like the goal id above) and send the SAME ids on, so the optimistic row
    // and the saved row can't disagree. The server still mints for a body that omits them.
    const checkpoints = body.checkpoints?.map((cp) => ({ ...cp, id: cp.id ?? Crypto.randomUUID() }));
    const optimistic: GoalRecord = { id, ...body, checkpoints };
    // Upsert into the cache: replace the id in place if present, else append.
    queryClient.setQueryData<GoalRecord[]>(['goals'], (prev) => {
      const list = prev ?? [];
      const at = list.findIndex((g) => g.id === id);
      if (at >= 0) { const next = [...list]; next[at] = optimistic; return next; }
      return [...list, optimistic];
    });
    // WHIT-271: on sign-out mid-flight, neither the success swap NOR the rollback may run —
    // both use `prev ?? []`, so on the cleared cache they'd SEED a stale/empty goals list into
    // the next session. Return false so the edit form's router.back() doesn't fire post-redirect.
    const epoch = sessionEpoch.current;
    try {
      const saved = await apiSaveGoal(id, { ...body, checkpoints });
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      // Swap the optimistic row for the server's authoritative one (same id).
      queryClient.setQueryData<GoalRecord[]>(['goals'], (prev) =>
        (prev ?? []).map((g) => (g.id === id ? saved : g)));
      return true;
    } catch {
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      // Roll back: restore the prior record for an edit, or drop the appended one for a create.
      queryClient.setQueryData<GoalRecord[]>(['goals'], (prev) => {
        const list = prev ?? [];
        return before ? list.map((g) => (g.id === id ? before : g)) : list.filter((g) => g.id !== id);
      });
      showToast('Could not save goal. Please try again.');
      return false;
    }
  }, [showToast]);

  // Delete a goal. Optimistically remove it from the ['goals'] cache, then DELETE server-side;
  // on failure put it back in front of the row that followed it (WHIT-254 — a saved index
  // would misplace it when two deletes fail at once) and warn. The server DELETE is idempotent
  // (unknown id → 200), so a rollback that races a refresh can't wedge. Unlike deleteRule
  // (whose patchRules no-ops on an evicted cache), this resurrects the row via `prev ?? []`.
  const deleteGoal = useCallback(async (id: string): Promise<boolean> => {
    const current = queryClient.getQueryData<GoalRecord[]>(['goals']) ?? [];
    const index = current.findIndex((g) => g.id === id);
    if (index === -1) return false;
    const removed = current[index];
    const successorIds = current.slice(index + 1).map((g) => g.id);
    queryClient.setQueryData<GoalRecord[]>(['goals'], (prev) => (prev ?? []).filter((g) => g.id !== id));
    // WHIT-271: a failure settling after sign-out must not resurrect the removed goal (via
    // `prev ?? []`) into the cleared cache, nor toast into the next session.
    const epoch = sessionEpoch.current;
    try {
      await apiDeleteGoal(id);
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight — don't fire the form's router.back()
      return true;
    } catch {
      if (epoch !== sessionEpoch.current) return false; // signed out mid-flight
      queryClient.setQueryData<GoalRecord[]>(['goals'], (prev) => reinsertBefore(prev ?? [], removed, successorIds));
      showToast('Could not delete goal. Please try again.');
      return false;
    }
  }, [showToast]);

  const value = useMemo<AppContext>(() => ({
    alerts,
    sheet, toast,
    pendingUncategorizedSelect,
    setSheet, readSheetDraft, writeSheetDraft, getSessionEpoch, showToast,
    requestUncategorizedSelect, clearUncategorizedSelect,
    toggleAlerts: () => setAlerts((a) => !a),
    setPayCycleLength, setPayday,
    openPicker, openMultiPicker, openGoalBalance, chooseCategory, applyCategory, applyCategoryToMany, previewRuleApplication, applyRulesToHistory, previewFileByShop, fileByShop, previewNewRule, fileNewRule, applyRulesJob, startApplyRulesSweep, startFileByShopJob, startNewRuleJob, retryApplyRulesJob, applyTransactionEdit, saveBudget, deleteBudget, saveSpread, removeSpread, saveCategory, createCategoryInline, deleteCategory, deleteRule, saveManualRule, updateRule, saveGoal, deleteGoal, saveLoanFacts, saveMilestones,
    aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights,
  }), [alerts, sheet, toast, pendingUncategorizedSelect, readSheetDraft, writeSheetDraft, getSessionEpoch, showToast, requestUncategorizedSelect, clearUncategorizedSelect, setPayCycleLength, setPayday, openPicker, openMultiPicker, openGoalBalance, chooseCategory, applyCategory, applyCategoryToMany, previewRuleApplication, applyRulesToHistory, previewFileByShop, fileByShop, previewNewRule, fileNewRule, applyRulesJob, startApplyRulesSweep, startFileByShopJob, startNewRuleJob, retryApplyRulesJob, applyTransactionEdit, saveBudget, deleteBudget, saveSpread, removeSpread, saveCategory, createCategoryInline, deleteCategory, deleteRule, saveManualRule, updateRule, saveGoal, deleteGoal, saveLoanFacts, saveMilestones, aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights]);

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

// The persisted pay cycle -> the live "days until the next payday" + cycle length,
// mirroring the server's current_cycle_window. Computed in UTC whole days (every
// UTC day is exactly 24h) so a Melbourne daylight-saving change can't shift the
// count by a day. daysLeft is clamped to [0, length]; on payday it reads `length`
// (a fresh cycle just began). Pure: the same (payCycle, today) always give the
// same result.
export function cycleClock(
  payCycle: { length: number; last_pay_date: string },
  today?: Date,
): { cycleLen: number; daysLeft: number } {
  const length = payCycle.length;
  const pay = isoToUtcDayMs(payCycle.last_pay_date);
  const now = today ?? new Date();
  const elapsedDays = wholeDaysBetween(pay, dateToUtcDayMs(now));       // integer-exact whole days
  const cyclesElapsed = Math.max(0, Math.floor(elapsedDays / length)); // mirrors max(0, //)
  const daysIntoCycle = elapsedDays - cyclesElapsed * length;
  const daysLeft = Math.max(0, Math.min(length, length - daysIntoCycle));
  return { cycleLen: length, daysLeft };
}

// The cycle clock the screens read: prefer the server's authoritative `days_left` (one clock,
// no UTC/Melbourne drift on the countdown — WHIT-341), falling back to the client cycleClock
// only for an older server / cold cache where the field is absent.
export function cycleClockView(
  payCycle: { length: number; last_pay_date: string; days_left?: number },
): { cycleLen: number; daysLeft: number } {
  // Clamp to [0, length] like cycleClock does — the server path bypasses cycleClock's own
  // clamp, so a corrupt/older cache value can't drive elapsedFrac out of [0,1] (negative bars).
  const daysLeft = payCycle.days_left ?? cycleClock(payCycle).daysLeft;
  return { cycleLen: payCycle.length, daysLeft: Math.max(0, Math.min(payCycle.length, daysLeft)) };
}

export function elapsedFrac(s: { cycleLen: number; daysLeft: number }) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }

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

export interface BudgetView {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spentLabel: string; remainAmount: string; remainLabel: string; remainColor: string;
  postedPct: number; pendingPct: number; targetPct: number; postedColor: string;
  pendingTint: string; paceLabel: string; paceColor: string; over: boolean;
  // Smoothing chip: "+$40 carried over" / "$20 borrowed", or '' when off / near zero.
  carryoverLabel: string;
  // Sub-category tree (WHIT-221): `depth` is the indent level — the number of the
  // row's ancestors that are ALSO budgeted rows (0 = top-level or a sub whose parent
  // isn't budgeted). `parentId` is the nearest budgeted ancestor's id (the row it
  // nests under), or null at the top level.
  depth: number; parentId: string | null;
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
}

export function budgetViews(s: BudgetViewsInput): { rows: BudgetView[]; totBudget: number; totSpent: number; totRemain: number } {
  const elapsed = elapsedFrac(s);
  let totBudget = 0, totSpent = 0, totRemain = 0;

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
    // Prefer the server-computed spendable (WHIT-549); fall back to the parts-sum for a server
    // that predates it. `??` (not `||`) so a legitimate 0 from the server is kept, not overridden.
    const available = b.available ?? (b.budget + (b.rollover ? b.carryover : 0) + b.spreadAdjustment);
    // Bars/remain divide by `available`, but it can be 0 or negative (a drained/borrowed
    // envelope) — fall back to the base target, then 1, so a percentage is never NaN.
    const den = available > 0 ? available : (b.budget > 0 ? b.budget : 1);
    // Pace stays on the base per-cycle target: "should I have spent this much of THIS
    // cycle's plan by now" — the buffer isn't part of the cycle's pace.
    const target = b.budget * elapsed;
    const postedPct = Math.max(0, Math.min(100, (posted / den) * 100));
    let carryoverLabel = '';
    if (b.rollover && b.carryover > 0.5) carryoverLabel = `+${fmt(b.carryover)} carried over`;
    else if (b.rollover && b.carryover < -0.5) carryoverLabel = `${fmt(-b.carryover)} borrowed`;

    if (c.bucket === 'Income') {
      // Earn-target (floor): over-is-good, so the direction and colours invert —
      // never red, being under target early in the cycle is calm, not alarming.
      // Income rows are kept OUT of the spend hero totals (a floor is a different
      // unit from a spend ceiling), but still listed. `over` stays false so nothing
      // downstream flips the row red.
      const met = actual >= b.budget;
      const pendingPct = Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
      let paceLabel: string, paceColor: string;
      // Same hierarchy as spend rows: the remaining amount is the cyan highlight, the pace
      // sub-label is the muted C.textInfo lavender.
      if (met) { paceLabel = fmtExact(actual - b.budget) + ' over target'; paceColor = C.textInfo; }
      else if (actual - target > 0.5) { paceLabel = fmt(actual - target) + ' ahead of pace'; paceColor = C.textInfo; }
      else if (target - actual > 0.5) { paceLabel = fmt(target - actual) + ' to go'; paceColor = C.textInfo; }
      else { paceLabel = 'on pace'; paceColor = C.textInfo; }
      // `actual` already includes pending, so the single "earned of budget" line counts it
      // without the separate "(… pending)" breakout.
      const spentLabel = `${fmtExact(actual)} earned of ${fmt(b.budget)}`;
      viewById.set(b.id, {
        id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
        spentLabel,
        remainAmount: fmtExact(met ? actual - b.budget : b.budget - actual),
        remainLabel: met ? 'over target' : 'to go',
        remainColor: C.good,
        postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: c.color,
        pendingTint: tint(c.color, 0.45), paceLabel, paceColor, over: false,
        carryoverLabel, depth, parentId,
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
    if (depth === 0) { totBudget += available; totSpent += spent; totRemain += remain; }
    const over = spent > available;
    const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / den) * 100, 100 - postedPct));
    let paceLabel: string, paceColor: string;
    // The "left" amount is the row's cyan highlight; the pace sub-label is the muted C.textInfo.
    // Warnings keep their own colour (over pace = amber, over budget = red).
    if (over) { paceLabel = fmtExact(spent - available) + ' over budget'; paceColor = C.bad; }
    else if (spent - target > 0.5) { paceLabel = fmt(spent - target) + ' over pace'; paceColor = C.warn; }
    else if (target - spent > 0.5) { paceLabel = fmt(target - spent) + ' under pace'; paceColor = C.textInfo; }
    else { paceLabel = 'on pace'; paceColor = C.textInfo; }
    // `spent` (= posted + pending) already counts pending, so a single "spent of budget" line
    // is enough — no separate "(… pending)" breakout. "of" shows the AVAILABLE envelope so it
    // reconciles with the remaining amount (which is available − spent).
    const spentLabel = `${fmtExact(spent)} spent of ${fmt(available)}`;
    viewById.set(b.id, {
      id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
      spentLabel, remainAmount: fmtExact(remain), remainLabel: over ? 'over' : 'left', remainColor: over ? C.bad : C.good,
      postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: over ? C.bad : c.color,
      pendingTint: tint(over ? C.bad : c.color, 0.45), paceLabel, paceColor, over,
      carryoverLabel, depth, parentId,
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

  return { rows, totBudget, totSpent, totRemain };
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

// Does the budget on `budgetId` own `categoryId`? — the client mirror of the server's
// subtree_ids (shared/spend.py): a budget's spend is its own category id PLUS every descendant
// in the SAME bucket. The descent passes THROUGH a cross-bucket intermediate to reach a
// same-bucket descendant, so only the two ENDPOINTS' buckets matter, not the nodes between. In a
// single-parent tree, walking UP the `parent` chain from categoryId and reaching budgetId proves
// categoryId is a descendant; we then keep it iff it is the root itself or shares the root's
// bucket (an absent category's bucket is `undefined`, mirroring the server's `None == None`).
// Cycle-safe via `seen`. Pinned to the server rule by the shared-fixture parity test
// (budgetSubtreeParity) so the two can't silently drift.
export function budgetSubtreeContains(categories: Category[], budgetId: string, categoryId: string): boolean {
  if (categoryId === budgetId) return true; // the root is always in its own subtree
  const byId = new Map(categories.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let cur = byId.get(categoryId)?.parent ?? null;
  while (cur && !seen.has(cur)) {
    if (cur === budgetId) return byId.get(categoryId)?.bucket === byId.get(budgetId)?.bucket;
    seen.add(cur);
    cur = byId.get(cur)?.parent ?? null;
  }
  return false; // categoryId is not a descendant of budgetId (an orphan/unknown id that isn't the root)
}

// WHIT-348: drop the given re-filed tx ids from every cached ['budgetTransactions', budgetId]
// list whose budget no longer owns their NEW category, so a re-file disappears from the old
// budget's detail list instantly (mirrors WHIT-344's exclude removal). Removal only — a charge
// re-filed INTO a budget is added back by the invalidate refetch, which owns the window + sort.
// Only rewrites a list that actually shrank (skips lists the id was never in). Returns the prior
// snapshots of ONLY the lists it changed, so a failed save rolls back exactly those (WHIT-360) —
// restoring untouched lists would clobber a concurrent refetch of an unrelated budget. Epoch-gated
// at the call site.
function removeRefiledFromBudgetLists(categories: Category[], ids: string[], newCategoryId: string) {
  const snapshots = queryClient.getQueriesData<Transaction[]>({ queryKey: ['budgetTransactions'] });
  const changed: typeof snapshots = [];
  snapshots.forEach(([key, data]) => {
    if (!data) return;
    const budgetId = key[1] as string;
    if (budgetSubtreeContains(categories, budgetId, newCategoryId)) return; // still owned by this budget
    const next = data.filter((t) => !ids.includes(t.transaction_id));
    if (next.length === data.length) return; // the id was never in this list — leave it untouched
    changed.push([key, data]);
    queryClient.setQueryData<Transaction[]>(key, next);
  });
  return changed;
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

// The sentinel category id the /breakdown endpoint uses for spend that counts to
// budget but has no home in the taxonomy (a raw BankSync enum, a deleted category,
// or null). Mirrors UNCATEGORIZED_KEY in lambda_api/constants.py.
export const UNCATEGORIZED_KEY = '__uncategorized__';

// The sentinel key the /breakdown endpoint uses for the total EARNED this cycle (all
// Income-bucket categories) — read by the Insights Earned-vs-Spent chart, never a spend
// row. Mirrors EARNED_KEY in lambda_api/constants.py.
export const EARNED_KEY = '__earned__';

// The sentinel key the /breakdown endpoint uses for the PER-SOURCE income breakdown (WHIT-366):
// {income_category_id: CategorySpend} for each Income-bucket category that earned this cycle.
// Rides in the same map as the per-category spend (same CategorySpend shape) but is income, not
// a spend row — read via `readIncomeSources`, and skipped in `categoryBreakdown` so it never
// counts as spend. Mirrors INCOME_KEY in lambda_api/constants.py.
export const INCOME_KEY = '__income__';

// The sentinel key the /breakdown endpoint uses for the server-owned parent roll-up (WHIT-349):
// netted parent totals + refund detail. It rides in the same map as the per-category spend but
// has a different shape, so it's read via `readRollup`, not the index type. Mirrors ROLLUP_KEY
// in lambda_api/constants.py. Defined here (not imported from ./api) so mocking ./api in a
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

// Whether a transaction counts toward budgets on the client: the bank said it
// counts AND the user hasn't manually excluded it ("mark as transfer", WHIT-296).
// Single source of truth so the uncategorized tab, its count, the row's actionable
// "Uncategorized" state, and the "apply to every {merchant}" sweep all drop an
// excluded transfer the same way the server does.
export function contributesToBudget(t: Transaction): boolean {
  // `!!` so an omitted counts_to_budget (undefined off the wire) returns a real `false`, not
  // `undefined` — otherwise it leaks through to transactionView.tappable, whose type is boolean.
  return !!t.counts_to_budget && !t.budget_excluded;
}

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
// Income / the category name) — plus the amount, so "coffee", "eating out" and "42" all work.
// Case-insensitive substring; `$` and `,` are stripped from the query so "$42" / "1,234" match.
// An empty query matches everything (the list is unfiltered). Pure over { category }.
export function transactionMatchesSearch(s: Pick<TransactionListInput, 'category'>, t: Transaction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  const categoryLabel = t.category === 'income' ? 'Income' : isUncategorized(s, t) ? 'Uncategorized' : (s.category(t.category)?.name ?? '');
  const haystack = `${merchantLabel(t)} ${t.description} ${categoryLabel} ${Math.abs(t.amount).toFixed(2)}`.toLowerCase();
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

// One row per distinct account_id, busiest first (a stable name tie-break keeps the order
// deterministic across renders). Feeds the Accounts tab.
export function accountSummaries(s: Pick<TransactionListInput, 'transactions'>): AccountSummary[] {
  const byId = new Map<string, Transaction[]>();
  for (const t of s.transactions) {
    if (!byId.has(t.account_id)) byId.set(t.account_id, []);
    byId.get(t.account_id)!.push(t);
  }
  const out = [...byId].map(([id, txns]) => ({ id, name: canonicalAccountName(txns, id), count: txns.length }));
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
  const available = budget.available ?? (budget.budget + (budget.rollover ? budget.carryover : 0) + budget.spreadAdjustment);
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
  // Prefer the server-computed spendable (WHIT-549); fall back to the parts-sum for a server
  // that predates it. `??` (not `||`) so a legitimate 0 from the server is kept, not overridden.
  const available = b.available ?? (b.budget + (b.rollover ? b.carryover : 0) + b.spreadAdjustment);
  const den = available > 0 ? available : (b.budget > 0 ? b.budget : 1);
  const postedPct = Math.max(0, Math.min(100, (posted / den) * 100));
  // The server already filters to contributing rows; during the optimistic window an
  // excluded row may linger, so gate on contributesToBudget before display (WHIT-525).
  const relItems = s.transactions.filter(contributesToBudget);
  const daysLeftLabel = `${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} remaining`;
  const targetPct = Math.round(elapsed * 100);
  // One line for the accumulated buffer, shown only when rollover is on and it's non-trivial.
  let carryoverLine = '';
  if (b.rollover && b.carryover > 0.5) carryoverLine = `Includes ${fmt(b.carryover)} carried over from past cycles`;
  else if (b.rollover && b.carryover < -0.5) carryoverLine = `Includes ${fmt(-b.carryover)} borrowed from this cycle`;
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
      spentBig: fmtExact(actual), ofBudget: 'of ' + fmt(b.budget),
      statusLabel: met ? 'Target reached — nice' : 'On track — keep earning',
      statusColor: met ? C.good : C.textInfo,
      postedPct, pendingPct,
      postedColor: c.color, pendingTint: tint(c.color, 0.45),
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
  // list label — so the same budget reads the same state on both screens. Spending past
  // today's linear target but still under the envelope is a caution, not a green "keep it up".
  const target = b.budget * elapsed;
  const aheadOfPace = !over && spent - target > 0.5;
  const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / den) * 100, 100 - postedPct));
  const remain = available - spent;
  const daily = remain > 0 ? remain / Math.max(1, s.daysLeft) : 0;
  // The shared eligibility rule (same one the transaction-screen prompt reads) also computes the
  // whole-cent overspend used as the spread prefill — one source, so the two screens can't diverge.
  const spreadElig = budgetSpreadEligibility(c, b);
  let statusLabel = 'On target — keep it up';
  let statusColor: string = C.good;
  if (over) { statusLabel = 'Over budget — ease up'; statusColor = C.bad; }
  else if (aheadOfPace) { statusLabel = 'Ahead of pace — ease up'; statusColor = C.warn; }
  return {
    ...common,
    spentBig: fmtExact(spent), ofBudget: 'of ' + fmt(available),
    statusLabel,
    statusColor,
    postedPct, pendingPct,
    postedColor: over ? C.bad : c.color, pendingTint: tint(over ? C.bad : c.color, 0.45),
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
