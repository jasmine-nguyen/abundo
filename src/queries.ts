// WHIT-188: server-read hooks backed by TanStack Query — the per-screen, cached,
// self-healing data layer that replaces the eager "load everything into one store on
// launch" design (see the WHIT-187 epic). This card wires up the Budgets screen; the
// other screens migrate in later cards, so the old context store stays intact until
// the WHIT-192 cleanup.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchBudgets, fetchBreakdown, fetchCategories, fetchPayCycle, fetchTransactions, fetchLoanFacts } from './api';
import type { BudgetRollup, CategorySpend, LoanFacts, PayCycle } from './api';
import { cycleClock, loanFactsReady, toBudget, toCategory } from './context';
import type { Budget, Category, Transaction } from './context';
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

// --- pure selectors over the raw API payloads (unit-tested in the logic project) ---
export function selectCategories(raw: unknown[]): Category[] {
  return raw.map(toCategory);
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

  // isLoading (isPending && isFetching), NOT isPending: a DISABLED query reports
  // isPending:true in v5, so basing the spinner on isPending would keep spinning after
  // the pay-cycle read ERRORED (which leaves budgets disabled) — stranding the user with
  // no Retry (code-critic/qa #1). isLoading is false for a disabled query, so an errored
  // dependency surfaces the error state instead of an endless spinner.
  const isLoading = payCycleQuery.isLoading || budgetsQuery.isLoading || categoriesQuery.isLoading;
  const isError = payCycleQuery.isError || budgetsQuery.isError || categoriesQuery.isError;

  const refetch = useCallback(() => {
    payCycleQuery.refetch();
    budgetsQuery.refetch();
    categoriesQuery.refetch();
  }, [payCycleQuery, budgetsQuery, categoriesQuery]);

  const refetchStale = useCallback(() => {
    if (payCycleQuery.isStale) payCycleQuery.refetch();
    if (budgetsQuery.isStale) budgetsQuery.refetch();
    if (categoriesQuery.isStale) categoriesQuery.refetch();
  }, [payCycleQuery, budgetsQuery, categoriesQuery]);

  return {
    budgets: budgetsQuery.data ?? [],
    category,
    cycleLen,
    daysLeft,
    isLoading,
    isError,
    refetch,
    refetchStale,
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

  // isLoading (not isPending) so a disabled query doesn't strand a spinner — see the
  // note in useBudgetsScreenData.
  const isLoading = payCycleQuery.isLoading || breakdownQuery.isLoading || categoriesQuery.isLoading;
  const isError = payCycleQuery.isError || breakdownQuery.isError || categoriesQuery.isError;

  const refetch = useCallback(() => {
    payCycleQuery.refetch();
    breakdownQuery.refetch();
    categoriesQuery.refetch();
  }, [payCycleQuery, breakdownQuery, categoriesQuery]);

  const refetchStale = useCallback(() => {
    if (payCycleQuery.isStale) payCycleQuery.refetch();
    if (breakdownQuery.isStale) breakdownQuery.refetch();
    if (categoriesQuery.isStale) categoriesQuery.refetch();
  }, [payCycleQuery, breakdownQuery, categoriesQuery]);

  return { breakdown: breakdownQuery.data ?? {}, category, isLoading, isError, refetch, refetchStale };
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

  const isLoading = transactionsQuery.isLoading || categoriesQuery.isLoading;
  const isError = transactionsQuery.isError || categoriesQuery.isError;
  // isFetching (not isLoading) drives pull-to-refresh: isLoading is false once data is
  // cached, so a pull-refresh of an already-loaded list must spin on isFetching instead.
  const isFetching = transactionsQuery.isFetching || categoriesQuery.isFetching;

  const refetch = useCallback(() => {
    transactionsQuery.refetch();
    categoriesQuery.refetch();
  }, [transactionsQuery, categoriesQuery]);

  const refetchStale = useCallback(() => {
    if (transactionsQuery.isStale) transactionsQuery.refetch();
    if (categoriesQuery.isStale) categoriesQuery.refetch();
  }, [transactionsQuery, categoriesQuery]);

  return {
    transactions: transactionsQuery.data ?? [],
    category,
    isLoading,
    isError,
    isFetching,
    refetch,
    refetchStale,
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
 * facts are set. Rules + pay-cycle + alerts + the profile identity stay on the old
 * store / auth (rules migrate in WHIT-195).
 */
export function useSettingsScreenData(): SettingsScreenData {
  const authed = useIsAuthed();
  const categoriesQuery = useCategoriesQuery(authed);
  const loanFactsQuery = useLoanFactsQuery(authed);

  const isLoading = categoriesQuery.isLoading || loanFactsQuery.isLoading;
  const isError = categoriesQuery.isError || loanFactsQuery.isError;

  const refetch = useCallback(() => {
    categoriesQuery.refetch();
    loanFactsQuery.refetch();
  }, [categoriesQuery, loanFactsQuery]);

  const refetchStale = useCallback(() => {
    if (categoriesQuery.isStale) categoriesQuery.refetch();
    if (loanFactsQuery.isStale) loanFactsQuery.refetch();
  }, [categoriesQuery, loanFactsQuery]);

  return {
    categoriesCount: categoriesQuery.data?.length ?? 0,
    loanReady: loanFactsQuery.data ? loanFactsReady(loanFactsQuery.data) : false,
    isLoading,
    isError,
    refetch,
    refetchStale,
  };
}
