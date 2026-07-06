// WHIT-174 — the load-error banner must NOT fire while signed out. AppProvider
// mounts ABOVE the auth gate, so its mount reads run at launch and throw
// "Not signed in" until there's a Cognito session. Those pre-login failures must
// leave loadError false (no "couldn't load" banner over the login screen). Once
// auth flips to 'authed' the provider reloads, and a genuine read failure THEN
// raises the banner. Real AppProvider; ../api and ../auth mocked.
//
// Fail-on-revert: reverting flagLoadError() back to an unconditional
// setLoadError(true) flips the first two cases (the banner would show while anon).
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';

let mockAuthStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'anon';
const mockAuthListeners = new Set<() => void>();
jest.mock('../auth', () => ({
  getStatus: () => mockAuthStatus,
  subscribe: (listener: () => void) => {
    mockAuthListeners.add(listener);
    return () => mockAuthListeners.delete(listener);
  },
}));

jest.mock('../api');
import * as api from '../api';
import { AppProvider, useAppContext } from '../context';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

function fireAuth(next: 'loading' | 'authed' | 'anon' | 'locked') {
  mockAuthStatus = next;
  mockAuthListeners.forEach((l) => l());
}

// Let the mount reads (and any queued microtasks/timers) settle.
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  mockAuthStatus = 'anon';
  mockAuthListeners.clear();
  mockApi.fetchTransactions.mockResolvedValue([]);
  mockApi.fetchCategories.mockResolvedValue([]);
  mockApi.fetchPayCycle.mockResolvedValue({ length: 14, last_pay_date: '2024-01-03' });
  mockApi.fetchBudgets.mockResolvedValue({});
  mockApi.fetchBreakdown.mockResolvedValue({});
  mockApi.fetchHomeLoan.mockResolvedValue({ balance: null, as_of: null, currency: null });
  mockApi.fetchLoanFacts.mockResolvedValue({ original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null });
  mockApi.fetchRepayment.mockResolvedValue({ amount: null, date: null, principal: null, interest: null });
  mockApi.listEnrichments.mockResolvedValue([]);
});

it('a failing mount read while SIGNED OUT does not raise the banner', async () => {
  // The launch reads reject exactly as they do on device before login.
  mockApi.fetchTransactions.mockRejectedValue(new Error('Not signed in'));
  mockApi.fetchCategories.mockRejectedValue(new Error('Not signed in'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  await flush();

  // anon → the failures are swallowed without flagging the global banner.
  expect(result.current.loadError).toBe(false);
});

it('the budgets mount call-site is also suppressed while signed out', async () => {
  // Covers the .catch(() => flagLoadError()) call-site path, not just the in-catch
  // self-flag reads. WHIT-189 retargeted this from breakdown (now Insights-owned) to
  // budgets, which still uses the identical mount-effect call-site (context.tsx).
  mockApi.fetchBudgets.mockRejectedValue(new Error('Not signed in'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(mockApi.fetchBudgets).toHaveBeenCalled());
  await flush();

  expect(result.current.loadError).toBe(false);
});

it('after login the provider reloads and a genuine read failure raises the banner', async () => {
  mockApi.fetchTransactions.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  await flush();
  expect(result.current.loadError).toBe(false); // still anon → no banner

  // Sign in → the auth subscription re-fires every read; this one still fails →
  // NOW (authed) the banner is allowed to surface.
  await act(async () => { fireAuth('authed'); });
  await waitFor(() => expect(result.current.loadError).toBe(true));
});

it('after login a clean reload leaves the banner down', async () => {
  // Signed-out mount reads all reject (no session), but on login every read
  // succeeds → the app populates and the banner never shows.
  mockApi.fetchTransactions.mockRejectedValueOnce(new Error('Not signed in'));
  mockApi.fetchCategories.mockRejectedValueOnce(new Error('Not signed in'));
  const { result } = renderHook(() => useAppContext(), { wrapper });

  await waitFor(() => expect(mockApi.fetchTransactions).toHaveBeenCalled());
  await flush();
  expect(result.current.loadError).toBe(false);

  await act(async () => { fireAuth('authed'); });
  await flush();
  expect(result.current.loadError).toBe(false);
});
