// WHIT-188: server-read hooks backed by TanStack Query — the per-screen, cached,
// self-healing data layer that replaces the eager "load everything into one store on
// launch" design (see the WHIT-187 epic). This card wires up the Budgets screen; the
// other screens migrate in later cards, so the old context store stays intact until
// the WHIT-192 cleanup.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery, replaceEqualDeep } from '@tanstack/react-query';
import { fetchBudgets, fetchBreakdown, fetchCategories, fetchPayCycle, fetchTransactions, fetchLoanFacts, fetchHomeLoan, fetchRepayment, listEnrichments } from './api';
import type { BudgetRollup, CategorySpend, EnrichmentRule, HomeLoan, LoanFacts, PayCycle, Repayment } from './api';
import { cycleClock, cycleName, loanFactsReady, toBudget, toCategory, toRule, EMPTY_LOAN_FACTS } from './context';
import type { Budget, Category, HomeLoanState, Rule, Transaction } from './context';
import { getStatus, subscribe } from './auth';

// --- auth gating -------------------------------------------------------------
// Queries must NOT fire before login (the reads throw "Not signed in") and MUST fire
// the moment auth flips to 'authed' (a login, or a Face-ID unlock). Subscribe to the
// same auth-status store the gate uses: when status changes, `enabled` flips and the
// query runs — mirroring the old store's subscribeAuthStatus reload. Gate on the exact
// 'authed' string (not merely "not anon"), so a 'locked' session — whose token read
// returns undefined — doesn't fire a doomed request.
const isAuthedSnapshot = (): boolean => getStatus() === 'authed';

export function useIsAuthed(): boolean {
  return useSyncExternalStore(subscribe, isAuthedSnapshot, isAuthedSnapshot);
}

// --- query keys (exported so write paths can invalidate the cache) -----------
export const categoriesKey = ['categories'] as const;
export const payCycleKey = ['payCycle'] as const;
// Budgets window on the pay-cycle length, so the length is part of the key — changing
// the cycle length refetches the correctly-windowed rollup rather than serving stale.
export const budgetsKey = (cycleLen: number) => ['budgets', cycleLen] as const;
// Breakdown (spend-by-category, the Insights tab) windows on the cycle length too, so
// it's keyed the same way — a cycle-length change refetches the right window.
export const breakdownKey = (cycleLen: number) => ['breakdown', cycleLen] as const;
// Transactions aren't windowed (fetchTransactions takes no args), so a flat key. Kept
// in sync with the literal ['transactions'] the categorise write uses in context.tsx
// (context imports queryClient directly, not this key, to avoid a circular import).
export const transactionsKey = ['transactions'] as const;
// Loan facts (the Settings "Loan details" row + the loan form). Un-windowed flat key,
// kept in sync with the literal ['loanFacts'] the saveLoanFacts write uses in context.tsx.
export const loanFactsKey = ['loanFacts'] as const;
// The live home-loan balance + the last repayment (the Goal tab + milestone screen).
// Un-windowed flat keys — WHIT-197. No write path touches them (balance is poller-fed,
// repayment is server-derived), so no in-context literal to keep in sync.
export const homeLoanKey = ['homeLoan'] as const;
export const repaymentKey = ['repayment'] as const;
// The categorisation rules (the Rules screen). Un-windowed flat key, kept in sync with
// the literal ['rules'] the rule writes double-write in context.tsx (context imports
// queryClient directly, not this key, to avoid a circular import) — WHIT-195.
export const rulesKey = ['rules'] as const;

// --- pure selectors over the raw API payloads (unit-tested in the logic project) ---
export function selectCategories(raw: unknown[]): Category[] {
  return raw.map(toCategory);
}
// WHIT-195: map the server enrichment rules into the client Rule shape (value→pattern,
// isNew:false for loaded rules). Reuses the same toRule the store uses, so the cache and
// the store's optimistic double-write agree field-for-field.
export function selectRules(raw: EnrichmentRule[]): Rule[] {
  // Fail LOUDLY on a malformed /enrichments payload (a wrapped or changed shape) — the
  // query rejects → the Rules screen shows its error card + Retry — rather than a cryptic
  // "raw.map is not a function" or silently rendering "0 rules" over data the user has.
  // Array.isArray also rejects null/undefined.
  if (!Array.isArray(raw)) throw new Error(`selectRules: expected an array from /enrichments, got ${typeof raw}`);
  return raw.map(toRule);
}
export function selectBudgets(rollups: Record<string, BudgetRollup>): Budget[] {
  return Object.entries(rollups)
    .filter(([, rollup]) => rollup.target > 0) // skip target<=0 so budget math never divides by 0
    .map(([id, rollup]) => toBudget(id, rollup));
}

// Server default, mirrored from AppProvider's seed (src/context.tsx) — used for the
// cycle clock before the payCycle query resolves so the hero shows a sensible "days
// left" rather than NaN on the very first paint.
const DEFAULT_PAY_CYCLE: PayCycle = { length: 14, last_pay_date: '2024-01-03' };

// --- the individual queries (each auth-gated) --------------------------------
export function useCategoriesQuery(enabled: boolean) {
  return useQuery({ queryKey: categoriesKey, queryFn: fetchCategories, enabled, select: selectCategories });
}

export function usePayCycleQuery(enabled: boolean) {
  return useQuery({ queryKey: payCycleKey, queryFn: fetchPayCycle, enabled });
}

export function useBudgetsQuery(cycleLen: number, enabled: boolean) {
  return useQuery({
    queryKey: budgetsKey(cycleLen),
    queryFn: () => fetchBudgets(cycleLen),
    enabled,
    select: selectBudgets,
  });
}

// Breakdown is already the Record<category id, {posted, pending}> the selector wants,
// so no `select`. WHIT-189.
export function useBreakdownQuery(cycleLen: number, enabled: boolean) {
  return useQuery({
    queryKey: breakdownKey(cycleLen),
    queryFn: () => fetchBreakdown(cycleLen),
    enabled,
  });
}

// WHIT-190a: the full transaction list (un-windowed).
export function useTransactionsQuery(enabled: boolean) {
  return useQuery({ queryKey: transactionsKey, queryFn: fetchTransactions, enabled });
}

// WHIT-191a: the user's home-loan facts (un-windowed).
export function useLoanFactsQuery(enabled: boolean) {
  return useQuery({ queryKey: loanFactsKey, queryFn: fetchLoanFacts, enabled });
}

// WHIT-197: the live home-loan balance. The API's `as_of` (snake) maps to the store's
// `asOf` so the Goal/milestone selectors read the same HomeLoanState shape as before.
// A null balance is a normal success (the poller hasn't run yet) — not an error — so
// the screens keep their "—"/"Fetching…" placeholder rather than an error state.
export function selectHomeLoan(raw: HomeLoan): HomeLoanState {
  return { balance: raw.balance, asOf: raw.as_of };
}
// WHIT-204: keep-last-good for the live balance. The poller can return a NULL balance
// (its row not yet written) AFTER a real one has loaded; without this, selectHomeLoan would
// map that null straight through and drop the Goal/milestone hero back to its "—"/"Fetching…"
// placeholder. As `structuralSharing`, this runs on every fetch — on BOTH the raw `HomeLoan`
// and the selected `HomeLoanState`, which each carry `.balance`: if the incoming balance is
// null but the previous value had a non-null one, keep the previous (same reference → the
// observer memoises `select`, so the loaded HomeLoanState survives). A first-ever null
// (oldData undefined) still yields null — a genuine "not polled yet" success, not a drop.
// Otherwise defer to replaceEqualDeep (TanStack's own default) so a deeply-equal refetch
// preserves referential identity and doesn't churn a re-render.
function keepLastGoodBalance<T>(oldData: T | undefined, newData: T): T {
  const prev = oldData as { balance: number | null } | undefined;
  const next = newData as { balance: number | null } | undefined;
  if (next?.balance == null && prev != null && prev.balance != null) return oldData as T;
  return replaceEqualDeep(oldData, newData);
}
export function useHomeLoanQuery(enabled: boolean) {
  return useQuery({ queryKey: homeLoanKey, queryFn: fetchHomeLoan, enabled, select: selectHomeLoan, structuralSharing: keepLastGoodBalance });
}

// WHIT-197: the most recent home-loan repayment (server-derived). Null-filled when
// none is on record — a graceful empty state, not an error.
export function useRepaymentQuery(enabled: boolean) {
  return useQuery({ queryKey: repaymentKey, queryFn: fetchRepayment, enabled });
}

// WHIT-195: the categorisation rules. Mapped in the queryFn (not `select`) so the cache
// holds Rule[] — the same shape the store's optimistic double-write mirrors, which lets a
// freshly-created rule carry its client-only isNew "NEW" badge through the coexistence
// window (a raw-EnrichmentRule cache couldn't).
export function useRulesQuery(enabled: boolean) {
  return useQuery({ queryKey: rulesKey, queryFn: async () => selectRules(await listEnrichments()), enabled });
}

// WHIT-203: the shared category-taxonomy hook. Every screen/overlay that only needs to
// LABEL something by category (the rules list, transaction rows, the pickers, the tab
// badge, the category screens) reads it from here — the single auth-gated ['categories']
// query — instead of the old store's `s.categories`/`s.category`. Surfaces both the array
// (callers that filter/sort the pickable list) and the null-tolerant `category(id)` lookup.
export interface CategoriesData {
  categories: Category[];
  category: (id: string | null) => Category | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}
export function useCategories(): CategoriesData {
  const authed = useIsAuthed();
  const categoriesQuery = useCategoriesQuery(authed);
  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);
  const refetch = useCallback(() => { categoriesQuery.refetch(); }, [categoriesQuery]);
  const refetchStale = useCallback(() => { if (categoriesQuery.isStale) categoriesQuery.refetch(); }, [categoriesQuery]);
  return { categories, category, isLoading: categoriesQuery.isLoading, isError: categoriesQuery.isError, refetch, refetchStale };
}

// WHIT-203: the shared pay-cycle hook — for the readers that need the cycle name / window
// but not the whole Budgets composite (the Settings "Pay cycle" row, the pay-cycle sheet).
// Falls back to the server default so cycleName/window are sensible before the read lands.
export interface PayCycleData {
  payCycle: PayCycle;
  cycleLen: number;
  daysLeft: number;
  cycleName: () => string;
  isLoading: boolean;
  isError: boolean;
}
export function usePayCycle(): PayCycleData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen, daysLeft } = cycleClock(payCycle);
  return { payCycle, cycleLen, daysLeft, cycleName: () => cycleName(cycleLen), isLoading: payCycleQuery.isLoading, isError: payCycleQuery.isError };
}

// --- shared screen-composite status plumbing (WHIT-204) ----------------------
// Every screen composite below repeats the SAME four status fields over its underlying
// queries. Hoisted here so the subtle semantics live in one place:
//   - isLoading = OR of the queries' `.isLoading`. Load-bearing: v5 `.isLoading` is
//     `isPending && isFetching`, NOT `isPending` — a DISABLED (auth-gated, or dependency-
//     errored) query reports isPending:true but isLoading:false, so ORing isLoading never
//     strands a spinner over an errored dependency (the way ORing isPending would). This is
//     the WHIT-188 code-critic/qa #1 fix, now enforced in ONE place.
//   - isError  = OR of the queries' `.isError`.
//   - refetch  = fire every query (the inline Retry / pull-to-refresh).
//   - refetchStale = fire only the queries whose data has gone stale (focus refresh with no
//     request storm), gated on each query result's built-in `.isStale`.
// It's a hook (calls useCallback), hence the `use` prefix. Passing the `queries` array
// straight as the useCallback deps reproduces each composite's former
// `useCallback(fn, [q1, q2, …])` element-for-element (React compares deps with Object.is),
// preserving the refetch/refetchStale IDENTITY the consumers' useFocusEffect depends on to
// avoid a re-subscribe storm. Each call site passes a fixed-length array, so the deps length
// is stable across renders.
interface CombinedQueryStatus {
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}
// The minimal slice of a query result the plumbing reads — every UseQueryResult satisfies it
// structurally, so composites pass their query objects straight in without a cast.
interface ScreenQuery {
  isLoading: boolean;
  isError: boolean;
  isStale: boolean;
  refetch: () => unknown;
}
function useCombineScreenQueries(queries: ScreenQuery[]): CombinedQueryStatus {
  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.some((q) => q.isError);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query array IS the deps
  const refetch = useCallback(() => { queries.forEach((q) => { q.refetch(); }); }, queries);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the query array IS the deps
  const refetchStale = useCallback(() => { queries.forEach((q) => { if (q.isStale) q.refetch(); }); }, queries);
  return { isLoading, isError, refetch, refetchStale };
}

// --- the Budgets screen's composite view -------------------------------------
export interface BudgetsScreenData {
  budgets: Budget[];
  category: (id: string) => Category | undefined;
  cycleLen: number;
  daysLeft: number;
  isLoading: boolean; // actively loading with nothing cached yet → show a spinner
  isError: boolean; // a read failed after its retries → show the inline retry
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches queries that have gone stale
}

/**
 * Everything the Budgets screen (and its budget math) needs, assembled from the
 * auth-gated queries. Budgets are keyed on the pay-cycle length, so they only fetch
 * once the real pay cycle has loaded — never with the default length and then again
 * with the real one.
 */
export function useBudgetsScreenData(): BudgetsScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen, daysLeft } = cycleClock(payCycle);

  const budgetsQuery = useBudgetsQuery(cycleLen, authed && payCycleQuery.isSuccess);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string) => byId.get(id), [byId]);

  const status = useCombineScreenQueries([payCycleQuery, budgetsQuery, categoriesQuery]);

  return {
    budgets: budgetsQuery.data ?? [],
    category,
    cycleLen,
    daysLeft,
    ...status,
  };
}

// --- the budget-detail screen's composite view (WHIT-203) --------------------
// app/budget/[id].tsx feeds budgetDetail(s, id), which reads the taxonomy + budgets +
// the category's transactions + the cycle window. Same shape as the Budgets composite
// plus the transaction list.
export interface BudgetDetailScreenData {
  category: (id: string | null) => Category | undefined;
  budgets: Budget[];
  transactions: Transaction[];
  cycleLen: number;
  daysLeft: number;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}
export function useBudgetDetailScreenData(): BudgetDetailScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen, daysLeft } = cycleClock(payCycle);

  const budgetsQuery = useBudgetsQuery(cycleLen, authed && payCycleQuery.isSuccess);
  const transactionsQuery = useTransactionsQuery(authed);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);

  // WHIT-204: the 7th composite folded into the shared helper (same plumbing as the six).
  const status = useCombineScreenQueries([payCycleQuery, budgetsQuery, transactionsQuery, categoriesQuery]);

  return {
    category,
    budgets: budgetsQuery.data ?? [],
    transactions: transactionsQuery.data ?? [],
    cycleLen,
    daysLeft,
    ...status,
  };
}

// --- the Insights screen's composite view (WHIT-189) -------------------------
export interface InsightsScreenData {
  breakdown: Record<string, CategorySpend>;
  category: (id: string) => Category | undefined;
  isLoading: boolean; // actively loading with nothing cached yet → show a spinner
  isError: boolean; // a read failed after its retries → show the inline retry
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches queries that have gone stale
}

/**
 * The Insights tab's spend-by-category data, assembled from the auth-gated queries.
 * Breakdown windows on the pay-cycle length, so it fetches only once the real pay cycle
 * has loaded (never with the default length then again with the real one). The AI-
 * insights feature on that screen stays on the old context store — it is NOT here.
 */
export function useInsightsScreenData(): InsightsScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen } = cycleClock(payCycle);

  const breakdownQuery = useBreakdownQuery(cycleLen, authed && payCycleQuery.isSuccess);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string) => byId.get(id), [byId]);

  const status = useCombineScreenQueries([payCycleQuery, breakdownQuery, categoriesQuery]);

  return { breakdown: breakdownQuery.data ?? {}, category, ...status };
}

// --- the Transactions screen's composite view (WHIT-190a) --------------------
export interface TransactionsScreenData {
  transactions: Transaction[];
  category: (id: string | null) => Category | undefined;
  isLoading: boolean; // first load, nothing cached yet → spinner
  isError: boolean; // a read failed after retries → inline retry
  isFetching: boolean; // any fetch in flight (incl. a background refetch) → pull-to-refresh spinner
  refetch: () => void; // force refresh (inline Retry / pull)
  refetchStale: () => void; // focus refresh — only refetches stale queries
}

/** Transactions + the category taxonomy for the row selectors. No pay-cycle window. */
export function useTransactionsScreenData(): TransactionsScreenData {
  const authed = useIsAuthed();
  const transactionsQuery = useTransactionsQuery(authed);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);

  const status = useCombineScreenQueries([transactionsQuery, categoriesQuery]);
  // isFetching (not isLoading) drives pull-to-refresh: isLoading is false once data is
  // cached, so a pull-refresh of an already-loaded list must spin on isFetching instead.
  // Kept OUT of the shared helper — it's a Transactions-only extra.
  const isFetching = transactionsQuery.isFetching || categoriesQuery.isFetching;

  return {
    transactions: transactionsQuery.data ?? [],
    category,
    isFetching,
    ...status,
  };
}

// --- the Settings screen's composite view (WHIT-191a) ------------------------
export interface SettingsScreenData {
  categoriesCount: number;
  loanReady: boolean; // whether loan facts are fully filled in ("Edit" vs "Set up")
  isLoading: boolean; // first load, nothing cached → show "…" instead of a misleading "0"
  isError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}

/**
 * The two Settings rows that read server data — the categories count and whether loan
 * facts are set. Pay-cycle + alerts + the profile identity stay on the old store / auth.
 * The rules COUNT also stays on the store: WHIT-195 migrated the Rules *screen* onto the
 * ['rules'] query, but the rule writes double-write the store too, so Settings' count
 * stays consistent without coupling a third query into this composite's loading state.
 */
export function useSettingsScreenData(): SettingsScreenData {
  const authed = useIsAuthed();
  const categoriesQuery = useCategoriesQuery(authed);
  const loanFactsQuery = useLoanFactsQuery(authed);

  const status = useCombineScreenQueries([categoriesQuery, loanFactsQuery]);

  return {
    categoriesCount: categoriesQuery.data?.length ?? 0,
    loanReady: loanFactsQuery.data ? loanFactsReady(loanFactsQuery.data) : false,
    ...status,
  };
}

// --- the Rules screen's composite view (WHIT-195) ----------------------------
export interface RulesScreenData {
  rules: Rule[];
  isLoading: boolean; // first load, nothing cached yet → spinner
  isError: boolean; // the read failed after retries → inline retry
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches when stale
}

/**
 * The Rules screen's data — just the categorisation rules. The category taxonomy that
 * labels each rule stays on the old store (s.category) until the WHIT-192 cleanup, so a
 * categories outage degrades a rule's label to "—" rather than erroring the whole screen.
 */
export function useRulesScreenData(): RulesScreenData {
  const authed = useIsAuthed();
  const rulesQuery = useRulesQuery(authed);

  const status = useCombineScreenQueries([rulesQuery]);

  return {
    rules: rulesQuery.data ?? [],
    ...status,
  };
}

// --- the Goal tab + milestone screen's composite view (WHIT-197) -------------
// The all-null defaults the selectors see before the reads resolve — same "unset"
// shapes the old store seeded, so goalView/milestoneView/lastRepaymentView render
// their "—"/"set this up"/empty states rather than crashing on undefined.
const EMPTY_HOME_LOAN: HomeLoanState = { balance: null, asOf: null };
const EMPTY_REPAYMENT: Repayment = { amount: null, date: null, principal: null, interest: null };

export interface GoalScreenData {
  loanFacts: LoanFacts;
  homeLoan: HomeLoanState;
  repayment: Repayment;
  isLoading: boolean; // first load, nothing cached yet
  isError: boolean; // ANY of the three reads failed after retries
  // The home-loan balance read's OWN error, kept separate from the aggregate: the
  // milestone "Couldn't load your balance" hero must key on this, NOT isError — a
  // repayment/loanFacts failure has nothing to do with the balance and must not
  // masquerade as a balance error (plan-critic #1).
  homeLoanError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}

/**
 * Everything the Goal tab + milestone screen read from the server — the live home-loan
 * balance, the last repayment, and the user's loan facts — assembled from the auth-gated
 * queries. The payoff/equity math (goalView/paydownView/milestoneView) is unchanged; it
 * just reads these instead of the eager store. Insights aiGoalSignal + the loan form stay
 * on the store until the WHIT-192 cleanup, so the loan-facts save's double-write keeps
 * both in sync.
 */
export function useGoalScreenData(): GoalScreenData {
  const authed = useIsAuthed();
  const homeLoanQuery = useHomeLoanQuery(authed);
  const repaymentQuery = useRepaymentQuery(authed);
  const loanFactsQuery = useLoanFactsQuery(authed);

  const status = useCombineScreenQueries([homeLoanQuery, repaymentQuery, loanFactsQuery]);

  return {
    loanFacts: loanFactsQuery.data ?? EMPTY_LOAN_FACTS,
    homeLoan: homeLoanQuery.data ?? EMPTY_HOME_LOAN,
    repayment: repaymentQuery.data ?? EMPTY_REPAYMENT,
    // homeLoanError: the balance read's OWN error, kept separate from the aggregate so the
    // milestone "Couldn't load your balance" hero keys on it, not a repayment/facts failure.
    homeLoanError: homeLoanQuery.isError,
    ...status,
  };
}
