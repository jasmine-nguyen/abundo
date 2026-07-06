// WHIT-203 test support — the screens migrated their server-data reads from the old
// store (useAppContext) to the query layer (src/queries hooks). Screen tests that seed a
// store-shaped fixture can re-route those reads with a single jest.mock line:
//
//   jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));
//
// The `() => mockState` getter is read at render time, so it tracks a fixture reassigned
// per test. Only the hooks a screen calls need to resolve; the rest are harmless stubs.
// (Not a *.test.ts file, so the jest testMatch never runs it as a suite.)

type AnyState = Record<string, unknown> & {
  categories?: { id: string }[];
  categoriesLoading?: boolean;
  budgets?: unknown[];
  transactions?: unknown[];
  rules?: unknown[];
  payCycle?: { length: number; last_pay_date: string };
  cycleLen?: number;
  daysLeft?: number;
  cycleName?: () => string;
  loanFacts?: unknown;
  homeLoan?: unknown;
  repayment?: unknown;
};

const noop = () => {};

export function queryMocksFromState(getState: () => AnyState) {
  const st = () => getState() ?? {};
  const cats = () => (st().categories ?? []) as { id: string }[];
  const category = (id: string | null) => (id == null ? undefined : cats().find((c) => c.id === id));
  const status = { isLoading: false, isError: false, refetch: noop, refetchStale: noop };
  return {
    useIsAuthed: () => true,
    useCategories: () => ({ categories: cats(), category, ...status, isLoading: st().categoriesLoading ?? false }),
    useBudgetsScreenData: () => ({ budgets: st().budgets ?? [], category, cycleLen: st().cycleLen ?? 14, daysLeft: st().daysLeft ?? 7, ...status }),
    useBudgetDetailScreenData: () => ({ category, budgets: st().budgets ?? [], transactions: st().transactions ?? [], cycleLen: st().cycleLen ?? 14, daysLeft: st().daysLeft ?? 7, ...status }),
    useTransactionsScreenData: () => ({ transactions: st().transactions ?? [], category, isFetching: false, ...status }),
    useRulesScreenData: () => ({ rules: st().rules ?? [], ...status }),
    usePayCycle: () => ({ payCycle: st().payCycle ?? { length: 14, last_pay_date: '2026-06-06' }, cycleLen: st().cycleLen ?? 14, daysLeft: st().daysLeft ?? 7, cycleName: st().cycleName ?? (() => 'Fortnightly'), isLoading: false, isError: false }),
    useSettingsScreenData: () => ({ categoriesCount: cats().length, loanReady: false, ...status }),
    useGoalScreenData: () => ({ loanFacts: st().loanFacts ?? {}, homeLoan: st().homeLoan ?? { balance: null, asOf: null }, repayment: st().repayment ?? {}, homeLoanError: false, ...status }),
    useLoanFactsQuery: () => ({ data: st().loanFacts }),
  };
}
