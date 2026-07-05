// Provider tests (WHIT-74) — the ADVERSARIAL half of the read/load-failure banner,
// i.e. the gaps the implementer's 7 cases in appProvider.screen.test.tsx don't lock.
// Their it.each covers fetchTransactions/fetchBudgets/fetchPayCycle; here we add the
// remaining pure reads (loanFacts, repayment) + the breakdown mount call-site, prove
// retryLoad is a FULL reload, prove home-loan/rules failures do NOT over-trigger the
// global banner (they own their own error UI), and prove the mount effects raise no
// unhandled promise rejection. Real AppProvider, ../api mocked.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';

jest.mock('../api');
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 } as const;
const TXN = {
  transaction_id: 't1', date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: null, status: 'posted', type: 'PAYMENT', counts_to_budget: true,
} as const;

beforeEach(() => {
  mockApi.fetchTransactions.mockResolvedValue([{ ...TXN }]);
  mockApi.fetchCategories.mockResolvedValue([{ ...CAT }]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
});

async function mount() {
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => {
    expect(result.current.categories.some((c) => c.id === 'groceries')).toBe(true);
    expect(result.current.transactions.length).toBeGreaterThan(0);
  });
  return result;
}

// --- the pure reads the implementer's it.each omits --------------------------
// loanFacts + repayment self-flag in their catch; breakdown is flagged at the mount
// call-site (.catch). All three must raise the banner.
it.each([
  ['fetchLoanFacts', () => mockApi.fetchLoanFacts.mockRejectedValue(new Error('x'))],
  ['fetchRepayment', () => mockApi.fetchRepayment.mockRejectedValue(new Error('x'))],
  ['fetchBreakdown', () => mockApi.fetchBreakdown.mockRejectedValue(new Error('x'))],
])('a failing %s on mount raises loadError', async (_name, reject) => {
  reject();
  const { result } = renderHook(() => useAppContext(), { wrapper });
  await waitFor(() => expect(result.current.loadError).toBe(true));
});

// --- reads with their OWN affordance must NOT raise the global banner ---------
it('a home-loan fetch failure does NOT raise the global banner (it owns homeLoanError)', async () => {
  mockApi.fetchHomeLoan.mockRejectedValue(new Error('network'));
  const result = await mount();
  await waitFor(() => expect(result.current.homeLoanError).toBe(true));
  // The home-loan poller has its own screen-local error; the global read banner
  // must stay down for it.
  expect(result.current.loadError).toBe(false);
});

it('a rules (enrichments) fetch failure does NOT raise the global banner (it owns enrichmentsError)', async () => {
  mockApi.listEnrichments.mockRejectedValue(new Error('network'));
  const result = await mount();
  await waitFor(() => expect(result.current.enrichmentsError).toBeTruthy());
  expect(result.current.loadError).toBe(false);
});

// --- retryLoad is a FULL reload ----------------------------------------------
// It re-fires every mount read — including the home-loan + rules reads that carry
// their own error UI — so the global "Retry" (and the Transactions pull-to-refresh
// that routes through it) recovers the whole app, not just the banner-flagged reads.
it('retryLoad re-fires every mount read (a full global reload)', async () => {
  const result = await mount();

  mockApi.fetchTransactions.mockClear();
  mockApi.fetchCategories.mockClear();
  mockApi.fetchPayCycle.mockClear();
  mockApi.fetchLoanFacts.mockClear();
  mockApi.fetchRepayment.mockClear();
  mockApi.fetchBudgets.mockClear();
  mockApi.fetchBreakdown.mockClear();
  mockApi.fetchHomeLoan.mockClear();
  mockApi.listEnrichments.mockClear();

  await act(async () => { result.current.retryLoad(); });

  expect(mockApi.fetchTransactions).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchCategories).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchPayCycle).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchLoanFacts).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchRepayment).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchBudgets).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchBreakdown).toHaveBeenCalledTimes(1);
  expect(mockApi.fetchHomeLoan).toHaveBeenCalledTimes(1);
  expect(mockApi.listEnrichments).toHaveBeenCalledTimes(1);
});

// --- no console throw on mount when the shared reads fail ---------------------
it('mount raises no unhandled promise rejection even when budgets + breakdown fail', async () => {
  // refreshBudgets/refreshBreakdown are shared with the write paths, so they DON'T
  // self-catch — the mount effect swallows their failure with a call-site .catch.
  // Removing that .catch would surface an unhandled rejection to the console. This
  // locks it: fail-on-revert if the .catch is dropped.
  mockApi.fetchBudgets.mockRejectedValue(new Error('5xx'));
  mockApi.fetchBreakdown.mockRejectedValue(new Error('5xx'));

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    await waitFor(() => expect(result.current.loadError).toBe(true));
    // Give any genuinely-unhandled rejection a couple of macrotasks to surface.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
});
