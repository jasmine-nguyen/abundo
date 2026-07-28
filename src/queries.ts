// WHIT-188: server-read hooks backed by TanStack Query — the per-screen, cached,
// self-healing data layer that replaces the eager "load everything into one store on
// launch" design (see the WHIT-187 epic). This card wires up the Budgets screen; the
// other screens migrate in later cards, so the old context store stays intact until
// the WHIT-192 cleanup.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useInfiniteQuery, useQueryClient, replaceEqualDeep } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { fetchBudgets, fetchBudgetTransactions, fetchBreakdown, fetchCategories, fetchCategoryTransactions, fetchPayCycle, fetchTransactions, fetchTransactionsFeed, fetchLoanFacts, fetchHomeLoan, fetchRepayment, fetchAccountBalances, fetchGoals, listEnrichments } from './api';
import type { AccountBalance, BudgetRollup, CategorySpend, EnrichmentRule, GoalRecord, HomeLoan, LoanFacts, PayCycle, Repayment, TransactionFeedPage } from './api';
import { cycleClockView, cycleName, loanFactsReady, toBudget, toCategory, toRule, EARNED_KEY, EMPTY_LOAN_FACTS } from './context';
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
// Budgets are un-windowed at the KEY (WHIT-72): the server derives the pay-cycle window
// itself (GET /budgets ignores the client ?days=), so a flat key is correct — it lets
// budgets fetch in PARALLEL with the pay cycle (no waterfall) and refetch exactly ONCE on
// a cycle-length change (the explicit invalidateQueries(['budgets']) in persistPayCycle),
// rather than a length change shifting the key AND the invalidate firing two fetches.
export const budgetsKey = ['budgets'] as const;
// The transactions behind one budget's total (the budget-detail list). A per-id key so
// each budget caches independently; the categorise writes invalidate the flat prefix so
// re-tagging a charge refreshes every cached budget's list.
export const budgetTransactionsKey = ['budgetTransactions'] as const;
// The transactions behind one /breakdown row (the category drill-in list). Keyed per
// category AND cycle so each look-back caches independently, like the breakdown query.
export const categoryTransactionsKey = ['categoryTransactions'] as const;
// Breakdown (spend-by-category, the Insights tab) is the same — server-derived window, so
// a flat key: parallel fetch, single invalidate on a length change (WHIT-72).
export const breakdownKey = ['breakdown'] as const;
// The Transactions tab's cursor-paged, all-accounts FEED (the "Load More" history). Held as
// an infinite query under this flat key. Kept in sync with the literal ['transactions'] the
// optimistic write path patches in context.tsx (context imports queryClient directly, not
// this key, to avoid a circular import) — those writes map over the InfiniteData pages.
export const transactionsKey = ['transactions'] as const;
// The BOUNDED "recent" list (the server's rolling window) behind the tab-bar dot, the
// account-detail screen, and the goal-edit picker. A SEPARATE key from the feed so those
// counts stay fixed and can't drift as the tab pages back through full history.
export const transactionsRecentKey = ['transactionsRecent'] as const;
// Loan facts (the Settings "Loan details" row + the loan form). Un-windowed flat key,
// kept in sync with the literal ['loanFacts'] the saveLoanFacts write uses in context.tsx.
export const loanFactsKey = ['loanFacts'] as const;
// The live home-loan balance + the last repayment (the Goal tab + milestone screen).
// Un-windowed flat keys — WHIT-197. No write path touches them (balance is poller-fed,
// repayment is server-derived), so no in-context literal to keep in sync.
export const homeLoanKey = ['homeLoan'] as const;
export const repaymentKey = ['repayment'] as const;
// The live per-account balances (the Accounts tab + account-detail header) — WHIT-212.
// Un-windowed flat key, poller-fed like the home-loan balance, so no write path touches it.
export const accountBalancesKey = ['accountBalances'] as const;
// The categorisation rules (the Rules screen). Un-windowed flat key, kept in sync with
// the literal ['rules'] the rule writes double-write in context.tsx (context imports
// queryClient directly, not this key, to avoid a circular import) — WHIT-195.
export const rulesKey = ['rules'] as const;
// The user's savings/debt goals (the Goals hub) — WHIT-233. Un-windowed flat key, kept in
// sync with the literal ['goals'] the goal writes touch in context.tsx (context imports
// queryClient directly, not this key, to avoid a circular import).
export const goalsKey = ['goals'] as const;

// --- pure selectors over the raw API payloads (unit-tested in the logic project) ---
export function selectCategories(raw: unknown[]): Category[] {
  // Fail LOUDLY on a malformed /categories payload (a wrapped or changed shape), mirroring
  // selectRules — the query rejects → the screen shows its error card (and, on a first load,
  // WHIT-194's categoriesError) instead of a cryptic "raw.map is not a function". Array.isArray
  // also rejects null/undefined. A genuine empty taxonomy is `[]`, which passes.
  if (!Array.isArray(raw)) throw new Error(`selectCategories: expected an array from /categories, got ${typeof raw}`);
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
// WHIT-233: the /goals payload is already the client GoalRecord shape (the server owns no
// mapping), so this is a passthrough that only FAILS LOUDLY on a malformed shape — mirroring
// selectCategories/selectRules. A non-array (a wrapped or changed payload) rejects the query
// → the hub shows its error card, instead of a cryptic "goals.map is not a function" later. A
// genuinely empty backlog is `[]`, which passes.
export function selectGoals(raw: unknown): GoalRecord[] {
  if (!Array.isArray(raw)) throw new Error(`selectGoals: expected an array from /goals, got ${typeof raw}`);
  return raw as GoalRecord[];
}

// Server default, mirrored from AppProvider's seed (src/context.tsx) — used for the
// cycle clock before the payCycle query resolves so the hero shows a sensible "days
// left" rather than NaN on the very first paint.
const DEFAULT_PAY_CYCLE: PayCycle = { length: 14, last_pay_date: '2024-01-03' };

// A query that ERRORED with nothing cached — a FIRST-LOAD failure, not a background-refetch
// failure over good data (TanStack v5 retains `.data` on the latter). Composites use this to
// force their error card ONLY when there's no last-good value to fall back on, so a failed
// background refetch keeps the cached rows (cache-first). Powers payCycleError (WHIT-72),
// categoriesError (WHIT-194), and — since WHIT-121 — homeLoanError + repaymentError; a bare
// `.isError` in any of them would wrongly surface an error over a cached last-good value.
function firstLoadError(q: { isError: boolean; data: unknown }): boolean {
  return q.isError && q.data === undefined;
}

// --- the individual queries (each auth-gated) --------------------------------
export function useCategoriesQuery(enabled: boolean) {
  return useQuery({ queryKey: categoriesKey, queryFn: fetchCategories, enabled, select: selectCategories });
}

export function usePayCycleQuery(enabled: boolean) {
  return useQuery({ queryKey: payCycleKey, queryFn: fetchPayCycle, enabled });
}

// cycleLen is passed to fetchBudgets for the (inert) ?days= arg only — the KEY is flat, so
// budgets fetches in parallel with the pay cycle and a length change doesn't shift it (WHIT-72).
export function useBudgetsQuery(cycleLen: number, enabled: boolean) {
  return useQuery({
    queryKey: budgetsKey,
    queryFn: () => fetchBudgets(cycleLen),
    enabled,
    select: selectBudgets,
  });
}

// The transactions behind one budget's total — the current cycle's whole subtree,
// server-filtered to the contributing rows and newest-first, so the budget-detail list
// sums to the header (the old 7-day feed under-counted a longer cycle). Per-id key.
export function useBudgetTransactionsQuery(categoryId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...budgetTransactionsKey, categoryId],
    queryFn: () => fetchBudgetTransactions(categoryId),
    enabled: enabled && !!categoryId,
  });
}

// The transactions behind one /breakdown row, for the category drill-in — the whole
// selected cycle, server-scoped to one category (or the uncategorized bucket), so the
// list reconciles with the Insights card (the old 7-day feed under-counted / went empty
// for last cycle). Keyed per category AND cycle, like useBreakdownQuery.
export function useCategoryCycleTransactionsQuery(categoryId: string, cycle: number, enabled: boolean) {
  return useQuery({
    queryKey: [...categoryTransactionsKey, categoryId, cycle],
    queryFn: () => fetchCategoryTransactions(categoryId, cycle),
    enabled: enabled && !!categoryId,
  });
}

// Breakdown is already the Record<category id, {posted, pending}> the selector wants,
// so no `select`. WHIT-189. Flat key + parallel fetch like budgets (WHIT-72). WHIT-68:
// the key is suffixed with `cycle` so each pay cycle's breakdown caches independently;
// `breakdownKey` stays the flat prefix, so the store's `['breakdown']` invalidations
// still prefix-match and refresh every cached cycle.
export function useBreakdownQuery(cycleLen: number, cycle: number, enabled: boolean) {
  return useQuery({
    queryKey: [...breakdownKey, cycle],
    queryFn: () => fetchBreakdown(cycleLen, cycle),
    enabled,
  });
}

// The Transactions tab's all-accounts feed as an infinite query: the first page is the
// newest batch (no cursor), each "Load More" fetches the next (older) page via the prior
// page's nextCursor, and hasNextPage goes false when the server returns nextCursor === null.
export function useTransactionsFeedQuery(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: transactionsKey,
    queryFn: ({ pageParam }) => fetchTransactionsFeed(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
}

// The bounded "recent" list (server rolling window) behind the dot, account detail, and the
// goal-edit picker — its OWN key, so the feed's Load More can't grow or disturb it.
export function useRecentTransactionsQuery(enabled: boolean) {
  return useQuery({ queryKey: transactionsRecentKey, queryFn: fetchTransactions, enabled });
}

// The Picker/Confirm sheets resolve the tapped transaction from the FEED cache. The tab-bar dot
// moved to the bounded recent query, so nothing else keeps the feed warm app-wide; the
// always-mounted tab bar mounts the feed's first page here (as it used to for the badge), so a
// sheet opened before the Transactions tab is ever visited still resolves the newest rows.
export function useKeepTransactionsFeedWarm(): void {
  useTransactionsFeedQuery(useIsAuthed());
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

// WHIT-212: live balance per account. Poller-fed (no write path invalidates it); an empty
// [] before the first poll is a normal success, not an error — the app shows a "—"
// placeholder per card. Kept SECONDARY to the transaction list: it is deliberately NOT
// folded into the Transactions composite's loading/error status, so a balances hiccup can
// never blank the transaction list or the account cards (which derive from transactions).
export function useAccountBalancesQuery(enabled: boolean) {
  return useQuery({ queryKey: accountBalancesKey, queryFn: fetchAccountBalances, enabled });
}

// WHIT-233: the user's savings/debt goals. Empty [] before the first goal is created — a
// normal success, not an error (the hub shows its "no goals yet" state). selectGoals guards
// the shape so a malformed payload rejects the query rather than crashing a downstream .map.
export function useGoalsQuery(enabled: boolean) {
  return useQuery({ queryKey: goalsKey, queryFn: fetchGoals, enabled, select: selectGoals });
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
// A single frozen empty array for the not-yet-loaded case, so `categories` keeps a STABLE
// identity across renders while the query is cold. A fresh `?? []` each render would make
// every consumer's `[categories]`-keyed memo/effect re-fire on every redraw — and in
// category/edit that turned an effect into an infinite re-render loop (WHIT-244).
const EMPTY_CATEGORIES: Category[] = [];
export function useCategories(): CategoriesData {
  const authed = useIsAuthed();
  const categoriesQuery = useCategoriesQuery(authed);
  const categories = categoriesQuery.data ?? EMPTY_CATEGORIES;
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
  const { cycleLen, daysLeft } = cycleClockView(payCycle);
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
  // WHIT-72: the pay-cycle read failed with NO cached cycle. Budgets now fetch in parallel
  // (not gated on the pay cycle), so a first-load pay-cycle failure would otherwise render
  // budget rows against the DEFAULT cycle — a wrong "days left" + pace. Force the error card
  // instead. Guarded on data===undefined so a background refetch over a cached cycle keeps
  // the rows (cache-first), mirroring WHIT-194's categoriesError.
  payCycleError: boolean;
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches queries that have gone stale
}

/**
 * Everything the Budgets screen (and its budget math) needs, assembled from the
 * auth-gated queries. Budgets, pay cycle, and categories all fetch in PARALLEL on auth
 * (WHIT-72): the budgets key is flat and the server derives its own window, so budgets no
 * longer waits for the pay cycle — killing the cold-open waterfall. cycleLen/daysLeft for
 * the hero still come from the pay-cycle query below, not the budgets payload.
 */
export function useBudgetsScreenData(): BudgetsScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen, daysLeft } = cycleClockView(payCycle);

  const budgetsQuery = useBudgetsQuery(cycleLen, authed);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string) => byId.get(id), [byId]);

  const status = useCombineScreenQueries([payCycleQuery, budgetsQuery, categoriesQuery]);
  // WHIT-72: a first-load pay-cycle failure (no cached cycle) → force the error card, else
  // budgets would render against the DEFAULT cycle (wrong days-left/pace).
  const payCycleError = firstLoadError(payCycleQuery);

  return {
    budgets: budgetsQuery.data ?? [],
    category,
    cycleLen,
    daysLeft,
    payCycleError,
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
  payCycleError: boolean; // WHIT-72: first-load pay-cycle failure → the pace/projection can't be trusted
  refetch: () => void;
  refetchStale: () => void;
}
export function useBudgetDetailScreenData(categoryId: string): BudgetDetailScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen, daysLeft } = cycleClockView(payCycle);

  const budgetsQuery = useBudgetsQuery(cycleLen, authed); // parallel fetch, flat key (WHIT-72)
  // The list is the whole cycle's subtree, computed server-side from the SAME window as
  // the header total, so the rows sum to the number — not the old rolling 7-day feed.
  const budgetTransactionsQuery = useBudgetTransactionsQuery(categoryId, authed);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);

  const status = useCombineScreenQueries([payCycleQuery, budgetsQuery, budgetTransactionsQuery, categoriesQuery]);
  const payCycleError = firstLoadError(payCycleQuery); // WHIT-72

  return {
    category,
    budgets: budgetsQuery.data ?? [],
    transactions: budgetTransactionsQuery.data ?? [],
    cycleLen,
    daysLeft,
    payCycleError,
    ...status,
  };
}

// --- the Insights screen's composite view (WHIT-189) -------------------------
export interface InsightsScreenData {
  breakdown: Record<string, CategorySpend>;
  // Total earned this cycle (all Income-bucket categories), server-computed over the
  // same window as spend, for the Earned-vs-Spent chart (WHIT-312). 0 when the response
  // carries no __earned__ bucket (no income, or an older server).
  earned: number;
  category: (id: string) => Category | undefined;
  isLoading: boolean; // actively loading with nothing cached yet → show a spinner
  isError: boolean; // a read failed after its retries → show the inline retry
  // WHIT-194: categories failed with NO cached taxonomy — real-category breakdown rows
  // can't be labelled, so the breakdown total is untrustworthy and the screen must show
  // the error (not a partial hero built from just the taxonomy-free Uncategorized bucket).
  // Guarded on data===undefined so it fires ONLY on a never-succeeded (first-load) read;
  // a background-refetch failure over good cached taxonomy retains `data` (TanStack v5),
  // keeps this false, and the cached rows keep rendering (cache-first preserved) — the same
  // firstLoadError data-guard the goal reads use, so a cached last-good value always wins.
  categoriesError: boolean;
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches queries that have gone stale
}

/**
 * The Insights tab's spend-by-category data, assembled from the auth-gated queries.
 * Breakdown, pay cycle, and categories fetch in PARALLEL on auth (WHIT-72): the breakdown
 * key is flat and the server derives its own window, so it no longer waits for the pay
 * cycle (kills the cold-open waterfall). The AI-insights feature on that screen stays on
 * the old context store — it is NOT here.
 */
export function useInsightsScreenData(cycle = 0): InsightsScreenData {
  const authed = useIsAuthed();
  const payCycleQuery = usePayCycleQuery(authed);
  const payCycle = payCycleQuery.data ?? DEFAULT_PAY_CYCLE;
  const { cycleLen } = cycleClockView(payCycle);

  // WHIT-68: `cycle` (0 = current, n = nth prior) selects the historical breakdown window.
  const breakdownQuery = useBreakdownQuery(cycleLen, cycle, authed); // parallel fetch, cycle-keyed
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string) => byId.get(id), [byId]);

  const status = useCombineScreenQueries([payCycleQuery, breakdownQuery, categoriesQuery]);
  // WHIT-194: see InsightsScreenData.categoriesError. firstLoadError ⇒ the categories read has
  // never succeeded, so there's no taxonomy to label real-category rows (cache-first preserved).
  const categoriesError = firstLoadError(categoriesQuery);

  // Earned rides in the breakdown response's __earned__ bucket (server-computed over the
  // same window as spend). posted + pending, matching how the spend total combines both.
  // Absent (no income, or an older server) ⇒ 0, so the chart falls back gracefully.
  const earnedEntry = breakdownQuery.data?.[EARNED_KEY];
  const earned = earnedEntry ? earnedEntry.posted + earnedEntry.pending : 0;

  return { breakdown: breakdownQuery.data ?? {}, earned, category, categoriesError, ...status };
}

// --- the Transactions screen's composite view (WHIT-190a) --------------------
// The bounded "recent" shape (tab-bar dot, account detail, goal-edit picker). No Load More.
export interface RecentTransactionsScreenData {
  transactions: Transaction[];
  category: (id: string | null) => Category | undefined;
  balances: Map<string, AccountBalance>; // account_id → live balance (WHIT-212); empty until polled
  isLoading: boolean; // first load, nothing cached yet → spinner
  isError: boolean; // a read failed after retries → inline retry
  isFetching: boolean; // any fetch in flight (incl. a background refetch) → pull-to-refresh spinner
  refetch: () => void; // force refresh (inline Retry / pull)
  refetchStale: () => void; // focus refresh — only refetches stale queries
}
// The Transactions TAB adds cursor pagination ("Load More") on top of the recent shape.
export interface TransactionsScreenData extends RecentTransactionsScreenData {
  hasMore: boolean; // more (older) history to page in → show the Load More control
  loadMore: () => void; // fetch the next (older) page
  isLoadingMore: boolean; // the next page is in flight → Load More spinner (NOT the pull spinner)
}

// A single frozen empty list for the cold case, so `transactions` keeps a STABLE identity
// across renders while a query is cold — otherwise every [transactions]-keyed memo/effect on
// the tab, dot, and sheets re-fires on each redraw (the WHIT-244 trap).
const EMPTY_TX: Transaction[] = [];

// Shared plumbing both transaction composites need: the null-tolerant category lookup and the
// live per-account balances map. Both take the already-computed `authed` flag so the composite
// gates its queries once.
function useCategoryLookup(authed: boolean) {
  const categoriesQuery = useCategoriesQuery(authed);
  const categories = categoriesQuery.data ?? EMPTY_CATEGORIES;
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);
  return { categoriesQuery, category };
}
function useBalancesMap(authed: boolean) {
  const balancesQuery = useAccountBalancesQuery(authed);
  // Secondary data: a balances failure/empty just means the cards show "—", so it is NOT
  // combined into isLoading/isError (it must not blank the list).
  return useMemo(
    () => new Map((balancesQuery.data ?? []).map((b) => [b.account_id, b])),
    [balancesQuery.data],
  );
}

/** The Transactions TAB: the all-accounts feed (with Load More), the category taxonomy for the
 *  row selectors, and the live per-account balances (WHIT-212). No pay-cycle window. */
export function useTransactionsScreenData(): TransactionsScreenData {
  const authed = useIsAuthed();
  const feedQuery = useTransactionsFeedQuery(authed);
  const { categoriesQuery, category } = useCategoryLookup(authed);
  const balances = useBalancesMap(authed);
  const queryClient = useQueryClient();

  // Flatten the loaded pages into one newest-first list, with a stable identity while cold.
  const transactions = useMemo(
    () => (feedQuery.data ? feedQuery.data.pages.flatMap((p) => p.transactions) : EMPTY_TX),
    [feedQuery.data],
  );

  const isLoading = feedQuery.isLoading || categoriesQuery.isLoading;
  const isError = feedQuery.isError || categoriesQuery.isError;
  // Pull-to-refresh spins on the FIRST-page fetch only; a Load More (fetchNextPage) must NOT
  // raise the pull spinner (WHIT-363), so exclude isFetchingNextPage.
  const isFetching = (feedQuery.isFetching && !feedQuery.isFetchingNextPage) || categoriesQuery.isFetching;

  const hasMore = feedQuery.hasNextPage;
  const isLoadingMore = feedQuery.isFetchingNextPage;
  const loadMore = useCallback(() => {
    if (feedQuery.hasNextPage && !feedQuery.isFetchingNextPage) feedQuery.fetchNextPage();
  }, [feedQuery]);

  // Refresh — the approved "keep your place, re-check on return" behaviour:
  //  • focus (refetchStale): re-check the loaded pages IN PLACE — refetch each by its own stable
  //    cursor, so the newest batch refreshes and the user keeps their scroll position. staleTime
  //    (45s) gates it, so rapid tab-switching doesn't refetch.
  //  • manual pull / inline Retry (refetch): SNAP to newest — trim to the first page, then refetch
  //    it fresh (+ the taxonomy). One round-trip, and it re-pages history cleanly from the top.
  const refetch = useCallback(() => {
    queryClient.setQueryData<InfiniteData<TransactionFeedPage>>(transactionsKey, (prev) =>
      prev && prev.pages.length > 1
        ? { pages: prev.pages.slice(0, 1), pageParams: prev.pageParams.slice(0, 1) }
        : prev);
    feedQuery.refetch();
    categoriesQuery.refetch();
  }, [feedQuery, categoriesQuery, queryClient]);
  const refetchStale = useCallback(() => {
    if (categoriesQuery.isStale) categoriesQuery.refetch();
    if (feedQuery.isStale) feedQuery.refetch(); // refetches every loaded page in place (keeps place)
  }, [feedQuery, categoriesQuery]);

  return { transactions, category, balances, isLoading, isError, isFetching, refetch, refetchStale, hasMore, loadMore, isLoadingMore };
}

/** The bounded "recent" reads (tab-bar dot, account detail, goal-edit picker): a fixed
 *  server-window list on its OWN key, so it can't grow or drift as the tab's feed pages back
 *  through history. Same composite shape the tab had before it moved to the feed. */
export function useRecentTransactionsScreenData(): RecentTransactionsScreenData {
  const authed = useIsAuthed();
  const recentQuery = useRecentTransactionsQuery(authed);
  const { categoriesQuery, category } = useCategoryLookup(authed);
  const balances = useBalancesMap(authed);

  const status = useCombineScreenQueries([recentQuery, categoriesQuery]);
  const isFetching = recentQuery.isFetching || categoriesQuery.isFetching;
  return {
    transactions: recentQuery.data ?? EMPTY_TX,
    category,
    balances,
    isFetching,
    ...status,
  };
}

// --- the category drill-in screen's composite view (WHIT-308, WHIT-342) -------
// app/category/[id].tsx feeds categoryTransactions(s, drillId): one category's (or the
// uncategorized bucket's) transactions for the selected cycle, fetched server-side over the
// SAME window as the /breakdown card (useCategoryCycleTransactionsQuery) — not the 7-day feed,
// which under-counted a longer cycle and returned nothing for last cycle (WHIT-342). The
// server owns the window now, so no pay-cycle query / payCycleError here. No balances query.
export interface CategoryTransactionsScreenData {
  transactions: Transaction[];
  category: (id: string | null) => Category | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  refetchStale: () => void;
}
export function useCategoryTransactionsScreenData(categoryId: string, cycle: number): CategoryTransactionsScreenData {
  const authed = useIsAuthed();
  const categoryTransactionsQuery = useCategoryCycleTransactionsQuery(categoryId, cycle, authed);
  const categoriesQuery = useCategoriesQuery(authed);

  const categories = categoriesQuery.data ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const category = useCallback((id: string | null) => (id == null ? undefined : byId.get(id)), [byId]);

  const status = useCombineScreenQueries([categoryTransactionsQuery, categoriesQuery]);

  return {
    transactions: categoryTransactionsQuery.data ?? [],
    category,
    ...status,
  };
}

// --- the Settings screen's composite view (WHIT-191a) ------------------------
export interface SettingsScreenData {
  categoriesCount: number;
  loanReady: boolean; // whether loan facts are fully filled in ("Edit" vs "Set up")
  // WHIT-198: per-row first-load failures. `firstLoadError` (not the aggregate isError) so a
  // background-refetch failure over a cached count/facts keeps the last-good value — only a
  // NEVER-loaded read surfaces "—" + retry, instead of a misleading "0" / "Set up".
  categoriesError: boolean;
  loanReadyError: boolean;
  isLoading: boolean; // first load, nothing cached → show "…" instead of a misleading "0"
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
    categoriesError: firstLoadError(categoriesQuery),
    loanReadyError: firstLoadError(loanFactsQuery),
    ...status,
  };
}

// --- the Rules screen's composite view (WHIT-195) ----------------------------
export interface RulesScreenData {
  rules: Rule[];
  isLoading: boolean; // first load, nothing cached yet → spinner
  isError: boolean; // the read failed after retries → inline retry
  // WHIT-198: first-load failure (nothing cached) — lets the Settings rules row show "—" rather
  // than a misleading "0", cache-first like categoriesError/loanReadyError.
  rulesError: boolean;
  refetch: () => void; // force a refresh (the inline Retry button)
  refetchStale: () => void; // focus refresh — only refetches when stale
}

/**
 * The Rules screen's data — just the categorisation rules. The category taxonomy that
 * labels and groups each rule is read separately via useCategories(), so a categories
 * outage/cold-load degrades gracefully (rules collapse under one "Uncategorized" header
 * until the taxonomy loads) rather than erroring the whole screen.
 */
export function useRulesScreenData(): RulesScreenData {
  const authed = useIsAuthed();
  const rulesQuery = useRulesQuery(authed);

  const status = useCombineScreenQueries([rulesQuery]);

  return {
    rules: rulesQuery.data ?? [],
    rulesError: firstLoadError(rulesQuery),
    ...status,
  };
}

// --- the Goals hub's composite view (WHIT-233) -------------------------------
// A frozen empty array for the not-yet-loaded case, so `goals` keeps a STABLE identity
// across renders while the query is cold — a fresh `?? []` each render would re-fire every
// consumer's `[goals]`-keyed memo/effect on every redraw (the WHIT-244 trap).
const EMPTY_GOALS: GoalRecord[] = [];

export interface GoalsScreenData {
  goals: GoalRecord[];
  payCycle: PayCycle; // for the per-goal pace math (balanceGoalView needs the cycle)
  // Resolve a SYNCED goal's live SIGNED balance (AccountBalance.amount) by its account id;
  // null when that account isn't in the balances payload yet (unpolled) or the balances read
  // hasn't landed. Feeds balanceGoalView's `balance` input.
  balanceFor: (accountId: string | null | undefined) => number | null;
  loanFacts: LoanFacts; // the mortgage summary card (WHIT-233 keeps the mortgage as one card)
  homeLoan: HomeLoanState;
  // The mortgage summary card's OWN first-load error, kept separate from the aggregate so a
  // mortgage hiccup shows the card's "—" + retry, never blanks the goals list.
  mortgageError: boolean;
  isLoading: boolean; // first load, nothing cached yet → spinner
  isError: boolean; // a PRIMARY read failed after retries → inline retry
  refetch: () => void; // force a refresh (inline Retry / pull-to-refresh)
  refetchStale: () => void; // focus refresh — only refetches stale queries
}

/**
 * Everything the Goals hub reads: the user's goals, the pay cycle (the pace math needs it),
 * a live-balance lookup for synced goals, and the mortgage summary (kept as one card this
 * card). isLoading/isError come ONLY from the two PRIMARY reads — the goals list + pay cycle,
 * which the screen genuinely can't render without. Account balances and the mortgage reads
 * are SECONDARY (WHIT-212 pattern): a hiccup there degrades one card ("—" + its own retry),
 * never blanks the whole hub — so they're kept out of the primary loading/error status.
 */
export function useGoalsScreenData(): GoalsScreenData {
  const authed = useIsAuthed();
  const goalsQuery = useGoalsQuery(authed);
  const payCycleQuery = usePayCycleQuery(authed);
  const balancesQuery = useAccountBalancesQuery(authed);
  const homeLoanQuery = useHomeLoanQuery(authed);
  const loanFactsQuery = useLoanFactsQuery(authed);

  // account_id → live SIGNED balance. Secondary data: a balances failure/empty just means a
  // synced card shows "—", so it must NOT gate the screen's loading/error status.
  const byAccount = useMemo(
    () => new Map((balancesQuery.data ?? []).map((b) => [b.account_id, b.amount])),
    [balancesQuery.data],
  );
  const balanceFor = useCallback(
    (accountId: string | null | undefined) => (accountId == null ? null : byAccount.get(accountId) ?? null),
    [byAccount],
  );

  // Retry / pull-to-refresh fire EVERY read (incl. the secondary balances + mortgage summary)
  // so a pull refreshes the whole hub. But isLoading/isError below come from only the two
  // PRIMARY reads, so this can't be a straight `...status` spread like the other composites.
  const combined = useCombineScreenQueries([goalsQuery, payCycleQuery, balancesQuery, homeLoanQuery, loanFactsQuery]);

  return {
    goals: goalsQuery.data ?? EMPTY_GOALS,
    payCycle: payCycleQuery.data ?? DEFAULT_PAY_CYCLE,
    balanceFor,
    loanFacts: loanFactsQuery.data ?? EMPTY_LOAN_FACTS,
    homeLoan: homeLoanQuery.data ?? EMPTY_HOME_LOAN,
    // firstLoadError (not bare .isError, like homeLoanError in useGoalScreenData): a cached
    // balance — real OR a genuine "not polled yet" null — survives a failed background
    // refetch as honest waiting copy; only a NEVER-loaded read flags the card's error.
    mortgageError: firstLoadError(homeLoanQuery),
    isLoading: goalsQuery.isLoading || payCycleQuery.isLoading,
    isError: goalsQuery.isError || payCycleQuery.isError,
    refetch: combined.refetch,
    refetchStale: combined.refetchStale,
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
  // The home-loan balance read's OWN error, kept separate from the aggregate: the Goal +
  // milestone "Couldn't load your balance" heroes must key on this, NOT isError — a
  // repayment/loanFacts failure has nothing to do with the balance and must not masquerade
  // as a balance error (plan-critic #1). firstLoadError (isError with NOTHING cached), like
  // repaymentError: a balance that once loaded (even a legitimately NULL "not polled yet"
  // success) then hit a failed refetch keeps its cached value — the honest render is the
  // waiting copy, not "couldn't load". Only a never-loaded read flags an error (WHIT-121).
  homeLoanError: boolean;
  // The last-repayment read's OWN error, likewise kept separate from the aggregate
  // (WHIT-121). Without it a failed repayment fetch falls back to EMPTY_REPAYMENT and the
  // Goal card shows its "No repayment on record yet" empty state — falsely telling a user
  // with a repayment they have none. The card keys its error+Retry affordance on this.
  // This is firstLoadError (isError with NOTHING cached), NOT a bare .isError like
  // homeLoanError: a repayment that once loaded EMPTY (a user who genuinely has none) then
  // hits a failed background refetch retains its cached empty value — the honest render
  // there is the empty state, not "couldn't load". A first-load failure (never any data) is
  // the only case with nothing truthful to show, so it's the only one that flags an error.
  // (homeLoanError uses the same firstLoadError rule — see above.)
  repaymentError: boolean;
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
    // Goal + milestone "Couldn't load your balance" heroes key on it, not a repayment/facts
    // failure. firstLoadError (WHIT-121): a cached balance — real OR a legitimately-null "not
    // polled yet" success — survives a failed background refetch as the honest waiting copy,
    // never a false error; only a never-loaded read flags one.
    homeLoanError: firstLoadError(homeLoanQuery),
    // repaymentError: the last-repayment read's OWN error (WHIT-121), so the Goal card's
    // error+Retry keys on it, not a balance/facts failure. firstLoadError (not bare .isError):
    // only a never-loaded read flags an error, so a cached repayment — real OR genuinely empty
    // — survives a failed background refetch and renders its honest last-good state.
    repaymentError: firstLoadError(repaymentQuery),
    ...status,
  };
}
