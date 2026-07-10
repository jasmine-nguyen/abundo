import React, { createContext, useContext, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { tint, fmt } from './theme';
import { MONTHS } from './dateutil';
import { createCategory, updateCategory, deleteCategory as apiDeleteCategory, setBudget as apiSetBudget, setTransactionCategory as apiSetTransactionCategory, setTransactionCategories as apiSetTransactionCategories, setPayCycle as apiSetPayCycle, setLoanFacts as apiSetLoanFacts, LoanFacts, LoanFactsInput, Repayment, BudgetRollup, CategorySpend, createEnrichment, updateEnrichment, deleteEnrichment, EnrichmentRule, fetchAiInsights, generateAiInsights as apiGenerateAiInsights, AiInsights, AiGoalSignal } from './api';
import { MILESTONES, usableEquity as computeUsableEquity, milestoneTime } from './milestones';

export type { LoanFacts, LoanFactsInput } from './api';
// WHIT-190a: the categorise write double-writes the query cache (for the migrated
// Transactions list) alongside the old store (for the tab badge + budget detail).
// Import the singleton directly (not the ['transactions'] key from ./queries) to avoid
// a circular import — ./queries imports from this module.
import { queryClient } from './queryClient';

// The empty loan-facts shape shown until the user saves the form. Kept as a
// module const so every "unset" origin (initial state, a failed fetch) agrees.
// Exported (WHIT-197) so the Goal/milestone query composite has the same all-null
// default before the loan-facts read resolves.
export const EMPTY_LOAN_FACTS: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null, payoffGoalDate: null };

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
}
export interface Budget { id: string; budget: number; posted: number; pending: number; }
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
}
// `pattern` mirrors the server rule's `value`; `field`/`operator` carry the
// server facts (default description/contains for app-authored rules) so a rule
// surfaced from BankSync renders truthfully. `isNew` flags the "NEW" badge and
// is client-only (server rules load as isNew:false).
export interface Rule { id: string; pattern: string; categoryId: string; isNew: boolean; field?: string; operator?: string; }
export interface Goal {
  original: number; balance: number; homeValue: number; startYear: string;
  ratePct: number; baseRepay: number; extra: number;
  lastRepay: { amount: number; principal: number; interest: number; date: string };
}
// The live home-loan balance from BankSync (WHIT-8), kept SEPARATE from `goal`
// (which is illustrative seed data). `balance` is the outstanding mortgage
// principal as a positive number, null until the balance poller's first run lands.
export interface HomeLoanState { balance: number | null; asOf: string | null; }
export type Sheet =
  | { mode: 'picker'; txId: string }
  | { mode: 'confirm'; txId: string; categoryId: string }
  | { mode: 'addrule'; ruleId?: string }   // ruleId set -> editing an existing rule
  | { mode: 'paycycle' }
  | null;

export const BUCKETS: Bucket[] = ['Living', 'Lifestyle', 'Income', 'Savings'];
export const BUCKET_COLOR: Record<Bucket, string> = {
  Living: '#7FA9F0', Lifestyle: '#E59BD0', Income: '#35d9a0', Savings: '#C7A8F0',
};
export const PALETTE = ['#E8A87C', '#7FD49B', '#F08C8C', '#8AB4F8', '#F2A0C9', '#C7A8F0', '#F2C94C', '#6FD0C9', '#8FD46B', '#B0A8F0'];

// Max charges per batch category write. Mirrors the server's TRANSACTION_BATCH_MAX
// (lambda_api/constants.py) — the "All from this merchant" sweep splits into chunks
// of this size so a large merchant spans multiple requests instead of tripping the
// server's per-request cap. Keep the two equal.
const CATEGORY_BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Seed data (ported verbatim from Whittle.dc.html)
// ---------------------------------------------------------------------------
// WHIT-192: the old SEED_CATEGORIES fallback list is gone with the eager store — the
// category taxonomy now loads from the ['categories'] query (which shows its own empty/
// error states) rather than a fabricated seed. Only the illustrative demo goal remains.
const SEED_GOAL: Goal = {
  original: 500000, balance: 432900, homeValue: 640000, startYear: 'Mar 2021',
  ratePct: 5.74, baseRepay: 1240, extra: 200,
  lastRepay: { amount: 1440, principal: 1208, interest: 232, date: 'Today · 9:02am' },
};

export const CLEAN_NAME: Record<string, string> = {
  'DD *DOORDASH HUTIEUGOO': 'DoorDash',
  'UNIFLEX REMEDIAL MASSAGE': 'Uniflex Massage',
  'SQ *KKV INTERNATIONAL': 'KKV International',
};
export function cleanName(m: string) { return CLEAN_NAME[m] || m; }

// Best-effort display name for a transaction's merchant, applying the cleanup
// map. Single source of truth so the transaction row and the categorize sheets
// never diverge (the Transaction shape has merchant_name/description, not payee).
export function merchantLabel(t: Transaction): string {
  return cleanName(t.merchant_name || t.description);
}

// The `contains` pattern the "Every {merchant} charge" rule matches on. Where the
// merchant name appears inside the description, return that slice using the
// description's OWN casing — this drops the volatile store#/location/ref suffix so
// the rule generalises to future charges, while the preserved casing keeps the
// match working whether or not BankSync's `contains` is case-sensitive. Falls back
// to the full description when there's no clean merchant substring (behaves as
// before — a rule that only catches this exact description).
export function rulePattern(t: Transaction): string {
  const desc = t.description ?? '';
  const merchant = (t.merchant_name ?? '').trim();
  if (merchant) {
    const i = desc.toLowerCase().indexOf(merchant.toLowerCase());
    if (i >= 0) return desc.slice(i, i + merchant.length);
  }
  return desc;
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

const REPAY_LINES = [
  '−$1,440 just hit the mortgage. $1,208 of it murdered actual principal. The beast shrinks. 🪓',
  "Repayment landed: $1,440. That's another brick out of the wall. Future-you is doing a little dance. 💃",
  'Boom — $1,208 off the principal. The death-pledge dies a little more today. ⚰️',
];

// ---------------------------------------------------------------------------
// AppContext
// ---------------------------------------------------------------------------
// WHIT-192: the eager server-data store is gone — every screen reads the TanStack
// Query layer (src/queries) directly. AppContext now carries only what the query
// layer can't: the demo goal + alerts toggle, ephemeral UI (sheet/toast/notif), the
// write actions (which source their reads from the query cache), and the AI-insights
// slice (still store-held pending its own migration).
export interface AppContext {
  // data (client-only demo/seed state — not server reads)
  goal: Goal; alerts: boolean;
  // ephemeral ui
  sheet: Sheet; toast: string | null; notif: { body: string; time: string } | null;
  // actions
  setSheet: (s: Sheet) => void;
  showToast: (m: string) => void;
  dismissNotif: () => void;
  toggleAlerts: () => void;
  setPayCycleLength: (len: number) => void;
  setPayday: (last_pay_date: string) => void;
  openPicker: (txId: string) => void;
  chooseCategory: (categoryId: string) => void;
  applyCategory: (scope: 'one' | 'all') => Promise<void>;
  saveBudget: (categoryId: string, value: number) => Promise<boolean>;
  saveCategory: (editId: string | null, form: { name: string; bucket: Bucket; icon: string }) => Promise<boolean>;
  deleteCategory: (id: string) => Promise<boolean>;
  deleteRule: (id: string) => Promise<void>;
  saveManualRule: (pattern: string, categoryId: string) => Promise<void>;
  updateRule: (id: string, pattern: string, categoryId: string) => Promise<void>;
  saveLoanFacts: (next: LoanFactsInput) => Promise<boolean>;
  fireRepayment: () => void;

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
    color: raw.color ?? PALETTE[0],
    recent: typeof raw.recent === 'number' ? raw.recent : 0,
  };
}

// Merge a server budget target into the client Budget shape. The server rollup owns
// the target AND the computed posted/pending spend for the window, so we take all three
// straight from it. Module-level + exported so the ['budgets'] query's selectBudgets
// reuses the exact same mapping.
export function toBudget(id: string, rollup: BudgetRollup): Budget {
  return { id, budget: rollup.target, posted: rollup.posted, pending: rollup.pending };
}

// Map a server enrichment rule into the client `Rule` shape. `value` -> `pattern`
// (what the list renders); loaded rules are never "new". Module-level + exported
// (WHIT-195) so the ['rules'] query's selectRules reuses the exact same mapping.
export function toRule(raw: EnrichmentRule): Rule {
  return { id: raw.id, pattern: raw.value, categoryId: raw.categoryId, isNew: false, field: raw.field, operator: raw.operator };
}

const Ctx = createContext<AppContext | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [goal, setGoal] = useState<Goal>(SEED_GOAL);
  const [alerts, setAlerts] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notif, setNotif] = useState<{ body: string; time: string } | null>(null);
  // WHIT-192: rule edits are mirrored straight into the ['rules'] query cache the Rules
  // screen + Settings count read (the old eager store is gone). Applies the functional
  // updater to the cache — including the client-only isNew "NEW" badge, which a refetch
  // would reset to false. Guards an evicted/absent cache (gcTime is finite): when the
  // Rules screen was never opened there's nothing to patch, and opening it fetches fresh.
  // Literal ['rules'] key (not the queries.ts const) to avoid a circular import.
  const patchRules = useCallback((fn: (prev: Rule[]) => Rule[]) => {
    queryClient.setQueryData<Rule[]>(['rules'], (prev) => (prev ? fn(prev) : prev));
  }, []);

	// AI spending insights (WHIT-104). `refreshAiInsights` reads the per-cycle cache
	// (free); `generateAiInsights` is the paid "Analyse my spending" action. Error is
	// true only when the last GENERATE failed, so the button can show a retry; a
	// null-summary cache (nothing generated yet) is NOT an error.
	const [aiInsights, setAiInsights] = useState<AiInsights | null>(null);
	const [aiInsightsLoading, setAiInsightsLoading] = useState(false);
	const [aiInsightsError, setAiInsightsError] = useState(false);
	const refreshAiInsights = useCallback(async () => {
		try {
			setAiInsights(await fetchAiInsights());
		} catch {
			// A failed cache read leaves the current state intact (no error surfaced);
			// the user can still generate.
		}
	}, []);
	// `goal` is passed IN by the caller (computed from live state at tap time), not
	// read from a closure here — so this stays a stable useCallback([]) and can never
	// send a stale goal.
	const generateAiInsights = useCallback(async (goal?: AiGoalSignal | null) => {
		setAiInsightsLoading(true);
		setAiInsightsError(false);
		try {
			setAiInsights(await apiGenerateAiInsights(goal));
		} catch {
			setAiInsightsError(true);
		} finally {
			setAiInsightsLoading(false);
		}
	}, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notifTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repayIdx = useRef(0);

  // Clear the toast/notif timers on unmount so they can't fire a setState after
  // teardown (a leak that also kept the jest worker alive between tests).
  useEffect(() => () => {
    clearTimeout(toastTimer.current);
    clearTimeout(notifTimer.current);
  }, []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }, []);

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
      queryClient.setQueryData(['payCycle'], next);
      try {
        await apiSetPayCycle(next);
        // The window (length and/or payday) changed, so the server rollups move — refetch
        // the migrated Budgets/Insights reads. With the flat ['budgets']/['breakdown'] keys
        // (WHIT-72) this invalidate is the SINGLE refresh: the setQueryData(['payCycle'])
        // above no longer shifts a windowed key, so there is no second, redundant refetch.
        queryClient.invalidateQueries({ queryKey: ['budgets'] });
        queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      } catch {
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
    try {
      await apiSetLoanFacts(next);
      queryClient.invalidateQueries({ queryKey: ['loanFacts'] });
      return true;
    } catch {
      queryClient.setQueryData(['loanFacts'], prev);
      showToast('Could not save loan details. Please try again.');
      return false;
    }
  }, [showToast]);

  const dismissNotif = useCallback(() => { clearTimeout(notifTimer.current); setNotif(null); }, []);

  const openPicker = useCallback((txId: string) => setSheet({ mode: 'picker', txId }), []);
  const chooseCategory = useCallback(
    (categoryId: string) => setSheet((s) => (s && s.mode === 'picker' ? { mode: 'confirm', txId: s.txId, categoryId } : s)),
    [],
  );

  const applyCategory = useCallback(async (scope: 'one' | 'all'): Promise<void> => {
    // This is only ever triggered from the confirm sheet; ignore any other state.
    if (!sheet || sheet.mode !== 'confirm') return;
    const { txId, categoryId } = sheet;
    // WHIT-192: source the transactions + taxonomy from the query cache the screens read
    // (the eager store is gone). By the time the confirm sheet is open the Transactions
    // list + pickers have warmed both caches; an empty fallback just closes the sheet.
    const transactions = queryClient.getQueryData<Transaction[]>(['transactions']) ?? [];
    const categories = queryClient.getQueryData<Category[]>(['categories']) ?? [];
    const transaction = transactions.find((t) => t.transaction_id === txId);
    const category = categories.find((c) => c.id === categoryId);
    if (!transaction || !category) {
      setSheet(null); // nothing to categorise — just close the sheet
      return;
    }

    // WHIT-190a: optimistic tx edits go straight into the ['transactions'] query cache the
    // migrated list + tab badge + budget detail read. Guard an evicted/absent cache
    // (gcTime is finite).
    const patchTransactions = (fn: (prev: Transaction[]) => Transaction[]) => {
      queryClient.setQueryData<Transaction[]>(['transactions'], (prev) => (prev ? fn(prev) : prev));
    };
    // After a categorisation persists, invalidate the query caches the migrated screens
    // read. The ['budgets']/['breakdown']/['transactions'] invalidation is what closes the
    // ≤45s staleness (WHIT-193).
    const invalidateAfterCategorise = () => {
      queryClient.invalidateQueries({ queryKey: ['budgets'] });
      queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
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
      const sameMerchantIds = transactions
        .filter((t) =>
          t.counts_to_budget &&
          categoryIsUnmapped(t.category, (id) => categories.find((c) => c.id === id)) &&
          matchesRulePattern(t, ruleValue, transaction))
        .map((t) => t.transaction_id);

      // Optimistically file all of them under the chosen category (one state update).
      patchTransactions((prev) =>
        prev.map((existing) => {
          if (!sameMerchantIds.includes(existing.transaction_id)) return existing;
          return { ...existing, category: categoryId };
        }));

      // Optimistically add the rule; a durable BankSync rule is created below.
      // Keep its temp id so we can swap in the server id or roll it back.
      const tempRuleId = 'tmp-' + Date.now();
      patchRules((prev) => [
        { id: tempRuleId, pattern: ruleValue, categoryId, isNew: true },
        ...prev,
      ]);
      showToast(`Rule saved — future ${cleanName(transaction.description)} charges file as ${category.name}.`);
      setSheet(null); // close the confirm sheet

      // Persist the rule AND all the categorisations. The rule hits BankSync; the
      // charges go through the batch endpoint (WHIT-70) instead of N single PATCHes.
      // The server caps one request at CATEGORY_BATCH_LIMIT rows, so split into
      // chunks under that cap and send them together — one chunk for a normal sweep,
      // more only for an unusually large merchant. An empty sweep yields no chunks
      // (no call at all — the server would 400 an empty body).
      const updates = sameMerchantIds.map((id) => ({ id, category: categoryId }));
      const chunks: { id: string; category: string }[][] = [];
      for (let i = 0; i < updates.length; i += CATEGORY_BATCH_LIMIT) {
        chunks.push(updates.slice(i, i + CATEGORY_BATCH_LIMIT));
      }
      const [ruleOutcome, ...chunkOutcomes] = await Promise.allSettled([
        createEnrichment({ value: ruleValue, categoryId }),
        ...chunks.map((chunk) => apiSetTransactionCategories(chunk)),
      ]);

      // Reconcile the optimistic rule: swap in the real BankSync id on success (so
      // a later delete targets the real rule), or remove it on failure.
      if (ruleOutcome.status === 'fulfilled') {
        // Keep isNew so the "NEW" badge survives settlement (toRule defaults it
        // false for the load path, where rules genuinely aren't new).
        patchRules((prev) => prev.map((r) => (r.id === tempRuleId ? { ...toRule(ruleOutcome.value), isNew: true } : r)));
      } else {
        patchRules((prev) => prev.filter((r) => r.id !== tempRuleId));
      }

      // Failures, mapped BY ID (not array position — never trust server order),
      // merged across every chunk. An id is "saved" only if some chunk returned it
      // with status 'updated'; a rejected chunk (or a malformed/missing `results`,
      // guarded by `?? []`) leaves its ids absent -> treated as failed -> reverted.
      const savedIds = new Set<string>();
      for (const outcome of chunkOutcomes) {
        if (outcome.status !== 'fulfilled') continue;
        for (const r of outcome.value.results ?? []) {
          if (r.status === 'updated') savedIds.add(r.id);
        }
      }
      const failedIds = sameMerchantIds.filter((id) => !savedIds.has(id));
      if (failedIds.length > 0) {
        // Roll back only the ones whose save failed (back to uncategorised) — same
        // partial set on BOTH stores.
        patchTransactions((prev) =>
          prev.map((existing) => {
            if (!failedIds.includes(existing.transaction_id)) return existing;
            return { ...existing, category: null };
          }));
        showToast('Could not save some categories. Please try again.');
      } else if (ruleOutcome.status === 'rejected') {
        // Transactions filed fine; only the future-rule failed to persist.
        showToast('Filed, but could not save the rule for future charges.');
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
      showToast('Could not save category. Please try again.');
    }
  }, [sheet, showToast, patchRules]);

  const saveBudget = useCallback(
    async (categoryId: string, value: number): Promise<boolean> => {
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
      try {
        const saved = await apiSetBudget(categoryId, value);
        // The Budgets screen reads ['budgets'] and app/budget/edit.tsx invalidates it after
        // this returns true, so the just-saved target reconciles from the server rollup —
        // no optimistic cache write needed here.
        if (c) showToast(`${c.name} budget ${existing ? 'updated' : 'set'} to ${fmt(saved.target)}.`);
        return true;
      } catch {
        showToast('Could not save budget. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  const saveCategory = useCallback(
    async (editId: string | null, form: { name: string; bucket: Bucket; icon: string }): Promise<boolean> => {
      const name = form.name.trim();
      if (!name) return false;
      try {
        if (editId) {
          const updated = await updateCategory(editId, { name, bucket: form.bucket, icon: form.icon });
          queryClient.setQueryData<Category[]>(['categories'], (prev) => (prev ? prev.map((c) => (c.id === editId ? toCategory(updated) : c)) : prev));
          showToast('Category updated.');
        } else {
          const created = await createCategory({ name, bucket: form.bucket, icon: form.icon });
          queryClient.setQueryData<Category[]>(['categories'], (prev) => (prev ? [...prev, toCategory(created)] : prev));
          showToast('Category created.');
        }
        // WHIT-203: the setQueryData above shows the change instantly on the migrated
        // category screens / pickers (parity with deleteCategory); the invalidate then
        // reconciles with the server. Safe to invalidate — the category genuinely exists
        // server-side, so a refetch can't resurrect a stale one.
        queryClient.invalidateQueries({ queryKey: ['categories'] });
        return true;
      } catch {
        showToast('Could not save category. Please try again.');
        return false;
      }
    },
    [showToast],
  );

  const deleteCategory = useCallback(async (id: string): Promise<boolean> => {
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
      queryClient.setQueryData<Transaction[]>(['transactions'], (prev) => prev?.map((t) => (t.category === id ? { ...t, category: null } : t)));
      // The deleted category's in-cycle spend now falls into Uncategorized on the
      // breakdown; invalidate so the Insights tab re-pulls and reflects that.
      queryClient.invalidateQueries({ queryKey: ['breakdown'] });
      showToast('Category deleted.');
      return true;
    } catch {
      showToast('Could not delete category. Please try again.');
      return false;
    }
  }, [showToast, patchRules]);

  // Optimistically remove the rule, then delete it in BankSync; on failure put it
  // back where it was and tell the user. A temp-id rule (mid-create) deletes fine
  // too — the server DELETE is idempotent (unknown id -> 200), and a refresh
  // reconciles any brief create/delete race.
  const deleteRule = useCallback(async (id: string) => {
    // WHIT-192: source the rules snapshot (for the index/removed rollback) from the
    // ['rules'] query cache the screen reads, not a store useState.
    const current = queryClient.getQueryData<Rule[]>(['rules']) ?? [];
    const index = current.findIndex((r) => r.id === id);
    if (index === -1) return;
    const removed = current[index];
    patchRules((prev) => prev.filter((r) => r.id !== id));
    try {
      await deleteEnrichment(id);
    } catch {
      patchRules((prev) => {
        const next = [...prev];
        next.splice(Math.min(index, next.length), 0, removed);
        return next;
      });
      showToast('Could not delete rule. Please try again.');
    }
  }, [showToast, patchRules]);

  // Optimistically add the rule (temp id), create it in BankSync, then swap in the
  // real id — or remove it and warn on failure. Value is sent as typed (trimmed,
  // not upper-cased) so both rule-creation paths POST a consistent `value`.
  const saveManualRule = useCallback(async (pattern: string, categoryId: string) => {
    const value = pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: the toast copy needs the category name — sourced from the ['categories']
    // query cache the screens read, not a store useState.
    const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
    const tempRuleId = 'tmp-' + Date.now();
    patchRules((prev) => [{ id: tempRuleId, pattern: value, categoryId, isNew: true }, ...prev]);
    setSheet(null);
    if (c) showToast(`Rule added — ${value} files as ${c.name}.`);
    try {
      const created = await createEnrichment({ value, categoryId });
      // Keep isNew so the "NEW" badge survives settlement (toRule defaults it
      // false for the load path, where rules genuinely aren't new).
      patchRules((prev) => prev.map((r) => (r.id === tempRuleId ? { ...toRule(created), isNew: true } : r)));
    } catch {
      patchRules((prev) => prev.filter((r) => r.id !== tempRuleId));
      showToast('Could not save rule. Please try again.');
    }
  }, [showToast, patchRules]);

  // Optimistically edit a rule in place, then PUT it; roll back to the snapshot on
  // failure. The rule's field/operator are preserved (passed through) so a
  // non-default rule isn't silently reset to description/contains.
  const updateRule = useCallback(async (id: string, pattern: string, categoryId: string) => {
    const value = pattern.trim();
    if (!value || !categoryId) return;
    // WHIT-192: source the `before` snapshot (for rollback) + the category name from the
    // query caches the screens read, not store useStates.
    const before = queryClient.getQueryData<Rule[]>(['rules'])?.find((r) => r.id === id);
    if (!before) return;
    patchRules((prev) => prev.map((r) => (r.id === id ? { ...r, pattern: value, categoryId } : r)));
    setSheet(null);
    const c = queryClient.getQueryData<Category[]>(['categories'])?.find((x) => x.id === categoryId);
    if (c) showToast(`Rule updated — ${value} files as ${c.name}.`);
    try {
      const saved = await updateEnrichment(id, { value, categoryId, field: before.field, operator: before.operator });
      patchRules((prev) => prev.map((r) => (r.id === id ? { ...toRule(saved), isNew: r.isNew } : r)));
    } catch {
      patchRules((prev) => prev.map((r) => (r.id === id ? before : r)));
      showToast('Could not update rule. Please try again.');
    }
  }, [showToast, patchRules]);

  const fireRepayment = useCallback(() => {
    const principal = 1208;
    const body = REPAY_LINES[(repayIdx.current = (repayIdx.current + 1) % REPAY_LINES.length)];
    setGoal((g) => ({ ...g, balance: Math.max(0, g.balance - principal), lastRepay: { ...g.lastRepay, date: 'Just now' } }));
    setNotif({ body, time: 'now' });
    clearTimeout(notifTimer.current);
    notifTimer.current = setTimeout(() => setNotif(null), 5600);
  }, []);

  const value = useMemo<AppContext>(() => ({
    goal, alerts,
    sheet, toast, notif,
    setSheet, showToast, dismissNotif,
    toggleAlerts: () => setAlerts((a) => !a),
    setPayCycleLength, setPayday,
    openPicker, chooseCategory, applyCategory, saveBudget, saveCategory, deleteCategory, deleteRule, saveManualRule, updateRule, saveLoanFacts, fireRepayment,
    aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights,
  }), [goal, alerts, sheet, toast, notif, showToast, dismissNotif, setPayCycleLength, setPayday, openPicker, chooseCategory, applyCategory, saveBudget, saveCategory, deleteCategory, deleteRule, saveManualRule, updateRule, saveLoanFacts, fireRepayment, aiInsights, aiInsightsLoading, aiInsightsError, refreshAiInsights, generateAiInsights]);

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
  const [y, m, d] = payCycle.last_pay_date.split('-').map(Number);
  const pay = Date.UTC(y, m - 1, d);
  const now = today ?? new Date();
  const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); // device calendar day
  const DAY = 86400000;
  const elapsedDays = Math.round((t - pay) / DAY);                     // integer-exact whole days
  const cyclesElapsed = Math.max(0, Math.floor(elapsedDays / length)); // mirrors max(0, //)
  const daysIntoCycle = elapsedDays - cyclesElapsed * length;
  const daysLeft = Math.max(0, Math.min(length, length - daysIntoCycle));
  return { cycleLen: length, daysLeft };
}

export function elapsedFrac(s: { cycleLen: number; daysLeft: number }) { return (s.cycleLen - s.daysLeft) / s.cycleLen; }

export interface BudgetView {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spentLabel: string; remainAmount: string; remainLabel: string; remainColor: string;
  postedPct: number; pendingPct: number; targetPct: number; postedColor: string;
  pendingTint: string; paceLabel: string; paceColor: string; over: boolean;
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
  const rows: BudgetView[] = [];
  for (const b of s.budgets) {
    const c = s.category(b.id);
    if (!c) continue;
    // Savings-bucket budgets have no meaningful rollup — savings for this app is an
    // account balance, not categorised transactions, so a Savings target would render
    // a permanently-empty spend bar. Skip it entirely (row AND totals) until a real
    // account-balance goal exists (WHIT-201). New Savings budgets are already blocked
    // in app/budget/pick.tsx; this also hides one set before that or via re-bucketing.
    if (c.bucket === 'Savings') continue;
    // posted/pending come from the server rollup (computed over the window). For an
    // Income category the rollup is positive EARNINGS, not spend.
    const pending = b.pending, posted = b.posted, actual = posted + pending;
    const target = b.budget * elapsed;
    const postedPct = Math.max(0, Math.min(100, (posted / b.budget) * 100));

    if (c.bucket === 'Income') {
      // Earn-target (floor): over-is-good, so the direction and colours invert —
      // never red, being under target early in the cycle is calm, not alarming.
      // Income rows are kept OUT of the spend hero totals (a floor is a different
      // unit from a spend ceiling), but still listed. `over` stays false so nothing
      // downstream flips the row red.
      const met = actual >= b.budget;
      const pendingPct = Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
      let paceLabel: string, paceColor: string;
      if (met) { paceLabel = fmt(actual - b.budget) + ' over target'; paceColor = '#35d9a0'; }
      else if (actual - target > 0.5) { paceLabel = fmt(actual - target) + ' ahead of pace'; paceColor = '#35d9a0'; }
      else if (target - actual > 0.5) { paceLabel = fmt(target - actual) + ' to go'; paceColor = '#cfd2ff'; }
      else { paceLabel = 'on pace'; paceColor = '#35d9a0'; }
      const spentLabel = pending > 0
        ? `${fmt(actual)} earned (${fmt(pending)} pending) of ${fmt(b.budget)}`
        : `${fmt(actual)} earned of ${fmt(b.budget)}`;
      rows.push({
        id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
        spentLabel,
        remainAmount: fmt(met ? actual - b.budget : b.budget - actual),
        remainLabel: met ? 'over target' : 'to go',
        remainColor: met ? '#35d9a0' : '#cfd2ff',
        postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: c.color,
        pendingTint: tint(c.color, 0.45), paceLabel, paceColor, over: false,
      });
      continue;
    }

    // Spend budget (ceiling): under-is-good, over is red.
    const spent = actual, remain = b.budget - spent;
    totBudget += b.budget; totSpent += spent; totRemain += remain;
    const over = spent > b.budget;
    const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
    let paceLabel: string, paceColor: string;
    if (over) { paceLabel = fmt(spent - b.budget) + ' over budget'; paceColor = '#ff6b6b'; }
    else if (spent - target > 0.5) { paceLabel = fmt(spent - target) + ' over pace'; paceColor = '#f4b740'; }
    else if (target - spent > 0.5) { paceLabel = fmt(target - spent) + ' under pace'; paceColor = '#35d9a0'; }
    else { paceLabel = 'on pace'; paceColor = '#35d9a0'; }
    const spentLabel = pending > 0
      ? `${fmt(spent)} spent (${fmt(pending)} pending) of ${fmt(b.budget)}`
      : `${fmt(spent)} spent of ${fmt(b.budget)}`;
    rows.push({
      id: b.id, name: c.name, color: c.color, icon: c.icon, chipBg: tint(c.color, 0.15),
      spentLabel, remainAmount: fmt(remain), remainLabel: over ? 'over' : 'left', remainColor: over ? '#ff6b6b' : '#cfd2ff',
      postedPct, pendingPct, targetPct: Math.round(elapsed * 100), postedColor: over ? '#ff6b6b' : c.color,
      pendingTint: tint(over ? '#ff6b6b' : c.color, 0.45), paceLabel, paceColor, over,
    });
  }
  return { rows, totBudget, totSpent, totRemain };
}

// The sentinel category id the /breakdown endpoint uses for spend that counts to
// budget but has no home in the taxonomy (a raw BankSync enum, a deleted category,
// or null). Mirrors UNCATEGORIZED_KEY in lambda_api/constants.py.
export const UNCATEGORIZED_KEY = '__uncategorized__';

export interface CategoryBreakdownRow {
  id: string; name: string; color: string; icon: string; chipBg: string;
  spent: number; posted: number; pending: number;
  spentLabel: string; pct: number; uncategorized: boolean;
}

// The exact slice categoryBreakdown reads. A narrow input (not the whole AppContext) so
// the Insights screen can feed it query data — type-checked field-by-field, not cast
// (WHIT-189, mirrors BudgetViewsInput). WHIT-192: the selector logic tests feed a plain
// fixture (factory.makeState) that satisfies this shape structurally.
export interface CategoryBreakdownInput {
  breakdown: Record<string, CategorySpend>;
  category: (id: string) => Category | undefined;
}

// Spend by category for the current cycle (the Insights tab), sorted highest-first.
// Pure over { breakdown, category }: joins the server's per-category posted/pending
// (s.breakdown) with the taxonomy for name/icon/colour, and renders the "__uncategorized__"
// bucket with the app's Uncategorized styling (matches transactionView). Zero-spend
// rows are dropped; a real category id the server didn't fold but that's missing
// locally is skipped defensively. `pct` is each row's share of the cycle total (bar width).
export function categoryBreakdown(s: CategoryBreakdownInput): { rows: CategoryBreakdownRow[]; total: number } {
  const rows: CategoryBreakdownRow[] = [];
  let total = 0;
  for (const [id, spend] of Object.entries(s.breakdown)) {
    const posted = spend.posted, pending = spend.pending, spent = posted + pending;
    if (spent <= 0) continue;
    let name: string, color: string, icon: string, chipBg: string;
    if (id === UNCATEGORIZED_KEY) {
      name = 'Uncategorized'; color = '#c9b3f5'; icon = 'q'; chipBg = 'rgba(160,130,240,.16)';
    } else {
      const c = s.category(id);
      if (!c) continue;
      name = c.name; color = c.color; icon = c.icon; chipBg = tint(c.color, 0.15);
    }
    total += spent;
    rows.push({
      id, name, color, icon, chipBg, spent, posted, pending,
      spentLabel: pending > 0 ? `${fmt(spent)} · ${fmt(pending)} pending` : fmt(spent),
      pct: 0, uncategorized: id === UNCATEGORIZED_KEY,
    });
  }
  rows.sort((a, b) => b.spent - a.spent);
  for (const r of rows) r.pct = total > 0 ? (r.spent / total) * 100 : 0;
  return { rows, total };
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

// A transaction is uncategorized when it has no resolvable Whittle category: its
// category is null, or it points at an id not in the taxonomy (e.g. a raw BankSync
// category not yet mapped). 'income' is a category, not uncategorized. Single
// source of truth so the row label, the tab list, the badge — and the "apply to
// all" sweep — always agree.
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

export function transactionView(s: Pick<TransactionListInput, 'category'>, t: Transaction): TransactionView {
  const c = t.category == null || t.category === 'income' ? undefined : s.category(t.category);
  const uncategorized = isUncategorized(s, t);
  const isIncome = t.category === 'income';
  const key = uncategorized ? 'q' : isIncome ? 'home' : c!.icon;
  const amtStr = (t.amount < 0 ? '-' : '+') + '$' + Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    id: t.transaction_id, merchant: merchantLabel(t), amountLabel: amtStr, amountColor: t.amount > 0 ? '#35d9a0' : '#f1f1f4',
    isPending: t.status === 'pending', icon: key,
    iconColor: uncategorized ? '#c9b3f5' : isIncome ? '#9aa2b5' : c!.color,
    chipBg: uncategorized ? 'rgba(160,130,240,.16)' : isIncome ? 'rgba(154,162,181,.14)' : tint(c!.color, 0.15),
    categoryLabel: uncategorized ? 'Uncategorized' : isIncome ? 'Income' : c!.name,
    categoryColor: uncategorized ? '#c9b3f5' : isIncome ? '#9aa2b5' : '#9a9aa4',
    categoryWeight: uncategorized ? '700' : '500', tappable: uncategorized,
  };
}

export function transactionGroups(s: TransactionListInput, tab: 'all' | 'uncategorized') {
  const tabFilter = (t: Transaction) => (tab === 'uncategorized' ? t.counts_to_budget && isUncategorized(s, t) : true);
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
  return s.transactions.filter((t) => t.counts_to_budget && isUncategorized(s, t)).length;
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

// The narrow read-input for the budget-detail + budget-edit selectors (WHIT-203) — they
// read only the taxonomy lookup + budgets (+ transactions/cycle for detail), never the
// whole store. Narrowing lets the migrated budget screens feed cached query data straight
// in (the eager store is gone as of WHIT-192).
export interface BudgetDetailInput {
  category: (id: string) => Category | undefined;
  budgets: Budget[];
  transactions: Transaction[];
  cycleLen: number;
  daysLeft: number;
}
export interface BudgetEditInput {
  category: (id: string) => Category | undefined;
  budgets: Budget[];
  cycleName: () => string;
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
  // posted/pending come from the server rollup (computed over the window). For an
  // Income category this is positive EARNINGS toward an earn-target, not spend.
  const pending = b.pending, posted = b.posted, actual = posted + pending;
  const postedPct = Math.max(0, Math.min(100, (posted / b.budget) * 100));
  const relSeen = new Map<string, Transaction[]>();
  const relOrder: string[] = [];
  for (const t of s.transactions.filter((t) => t.category === b.id)) {
    const label = dateLabel(t.date);
    if (!relSeen.has(label)) { relSeen.set(label, []); relOrder.push(label); }
    relSeen.get(label)!.push(t);
  }
  const relGroups = relOrder.map((label) => ({ label, items: relSeen.get(label)! }));
  const daysLeftLabel = `${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} remaining`;
  const targetPct = Math.round(elapsed * 100);
  const common = { name: c.name, icon: c.icon, color: c.color, daysLeftLabel, targetPct, relGroups, relEmpty: relGroups.length === 0 };

  if (isIncome) {
    // Earn-target (floor): over-is-good, so the status is never red. Under target
    // early in the cycle is calm ("keep earning"), not an "ease up" warning.
    const met = actual >= b.budget;
    const pendingPct = Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
    const toGo = Math.max(0, b.budget - actual);
    const perDay = toGo > 0 ? toGo / Math.max(1, s.daysLeft) : 0;
    return {
      ...common,
      spentBig: fmt(actual), ofBudget: 'of ' + fmt(b.budget),
      statusLabel: met ? 'Target reached — nice' : 'On track — keep earning',
      statusColor: met ? '#35d9a0' : '#cfd2ff',
      postedPct, pendingPct,
      postedColor: c.color, pendingTint: tint(c.color, 0.45),
      dailyLabel: met ? 'Target reached' : `${fmt(perDay)}/day to target`,
    };
  }

  // Spend budget (ceiling): under-is-good, over is red.
  const spent = actual;
  const over = spent > b.budget;
  const pendingPct = over ? Math.max(0, 100 - postedPct) : Math.max(0, Math.min((pending / b.budget) * 100, 100 - postedPct));
  const remain = b.budget - spent;
  const daily = remain > 0 ? remain / Math.max(1, s.daysLeft) : 0;
  return {
    ...common,
    spentBig: fmt(spent), ofBudget: 'of ' + fmt(b.budget),
    statusLabel: over ? 'Over budget — ease up' : 'On target — keep it up',
    statusColor: over ? '#ff6b6b' : '#35d9a0',
    postedPct, pendingPct,
    postedColor: over ? '#ff6b6b' : c.color, pendingTint: tint(over ? '#ff6b6b' : c.color, 0.45),
    dailyLabel: over ? 'Daily limit: $0' : `Daily limit: ${fmt(daily)}`,
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
  };
}

// The narrow read-inputs for the Goal-tab + milestone selectors (WHIT-197). These
// five selectors read ONLY the user's loan facts + the live home-loan balance (and,
// for the repayment card, the last repayment) — never the pay cycle, categories, or
// the seed goal. Narrowing the param to exactly what they read lets the Goal/milestone/
// Insights screens feed cached query data straight in (type-checked, not cast). WHIT-192
// removed the eager store, so all callers now feed query data (or the Insights aiGoalSignal
// via useGoalScreenData).
export interface GoalViewInput { loanFacts: LoanFacts; homeLoan: HomeLoanState; }
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

  const depositTarget = 90000;
  const depositPct = usableEquity != null ? Math.max(0, Math.min(100, (usableEquity / depositTarget) * 100)) : 0;

  return {
    factsReady,
    liveBalance, balanceKnown, balanceLabel: balanceKnown ? fmt(liveBalance!) : '—',
    original, paidOff, paidPct,
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
  if (pv.mode === 'none' && pv.requiredRepay !== null && pv.requiredExtra !== null && pv.goalDateLabel !== null) {
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
// linear curve through the Sprint anchors: flat before Sprint 0 and after the
// final target, linearly interpolated between. The MILESTONES invariant
// (strictly increasing dates) guarantees the interpolation denominator is never
// zero. Pure over MILESTONES.
function expectedBalanceAt(t: number): number {
  const first = MILESTONES[0];
  const last = MILESTONES[MILESTONES.length - 1];
  if (t <= milestoneTime(first)) return first.targetBalance;
  if (t >= milestoneTime(last)) return last.targetBalance;
  for (let i = 1; i < MILESTONES.length; i++) {
    const a = MILESTONES[i - 1], b = MILESTONES[i];
    const ta = milestoneTime(a), tb = milestoneTime(b);
    if (t < tb) {
      return a.targetBalance + (b.targetBalance - a.targetBalance) * ((t - ta) / (tb - ta));
    }
  }
  return last.targetBalance; // unreachable (t < last handled above), keeps TS happy
}

// Progress against the Sprint 0–4 paydown plan (WHIT-8). Pure over the live
// home-loan balance (s.homeLoan) + the MILESTONES constants + `today` (injected
// for tests). Until the balance loads, hasBalance is false and the schedule
// verdict is null so the screen can show a waiting state instead of fake numbers.
export function milestoneView(s: GoalViewInput, today?: Date): MilestoneView {
  const rawBalance = s.homeLoan.balance;
  const hasBalance = typeof rawBalance === 'number';
  const balance = hasBalance ? rawBalance! : 0;

  // Equity needs the user's saved property value + LVR (Loan facts card); until
  // they're set, equity figures show a "set this up" state rather than a fake number.
  const homeValue = s.loanFacts.homeValue;
  const lvr = s.loanFacts.lvr;
  const equityKnown = typeof homeValue === 'number' && typeof lvr === 'number';

  const rows: MilestoneRow[] = MILESTONES.map((m) => ({
    sprint: m.sprint,
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

  const start = MILESTONES[0].targetBalance;
  const end = MILESTONES[MILESTONES.length - 1].targetBalance;
  const overallPct = hasBalance
    ? Math.max(0, Math.min(100, ((start - balance) / (start - end)) * 100))
    : 0;

  const equity = equityKnown && hasBalance ? computeUsableEquity(homeValue!, balance, lvr!) : null;

  let schedule: MilestoneView['schedule'] = null;
  if (hasBalance) {
    const now = today ?? new Date();
    const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const expectedBalance = expectedBalanceAt(t);
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
