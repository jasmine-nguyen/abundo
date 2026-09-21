// WHIT-191a/192 — saveLoanFacts optimistically writes the ['loanFacts'] query cache (the
// Goal + Settings + loan form read it), PUTs, then invalidates ONLY that key (home-loan
// balance + repayment don't depend on loan facts server-side), and rolls the cache back on
// failure. (Pre-192 it also double-wrote an old store; that store is gone.) Drives the REAL
// saveLoanFacts via AppProvider + the singleton queryClient.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { LoanFacts } from '../context';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const FACTS = { original: 500000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200 };
const EMPTY: LoanFacts = { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null };
const cachedFacts = () => queryClient.getQueryData<LoanFacts>(['loanFacts']);

beforeEach(() => {
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
});

// WHIT-192: seed the ['loanFacts'] cache the writer sources `prev` from (the provider no
// longer eager-loads), then mount.
function mount() {
  queryClient.setQueryData(['loanFacts'], EMPTY);
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveLoanFacts writes the cache + invalidates ONLY loanFacts', async () => {
  mockApi.setLoanFacts.mockResolvedValue(FACTS);
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveLoanFacts(FACTS); });

  expect(ok).toBe(true);
  expect(cachedFacts()).toEqual(FACTS); // query cache optimistic write
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('loanFacts');
  expect(keys).not.toContain('homeLoan'); // balance doesn't depend on facts
  expect(keys).not.toContain('repayment');
  invalidateSpy.mockRestore();
});

it('rolls the cache back on a save failure', async () => {
  mockApi.setLoanFacts.mockRejectedValue(new Error('boom'));
  const result = mount();

  // The optimistic write reaches the cache MID-FLIGHT (before the reject), then the catch
  // rolls it back to the pre-save facts. The mid check keeps teeth: without the optimistic
  // write the cache never changes and mid stays null.
  let mid: number | null | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveLoanFacts(FACTS);
    mid = cachedFacts()?.homeValue;   // optimistic → 770000
    ok = await p;
  });

  expect(ok).toBe(false);
  expect(mid).toBe(770000);           // <-- fails if the optimistic write is removed
  expect(cachedFacts()?.homeValue).toBeNull(); // rolled back to the pre-save (unset) facts
});
