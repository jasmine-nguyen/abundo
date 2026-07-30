// WHIT-377 — saveMilestones optimistically writes the ['milestones'] query cache (the milestone +
// mortgage screens read it), PUTs the whole list, then invalidates that key so the screen refreshes
// (milestones is out of the read composite's refetch, so the save's own invalidate is what updates
// it), and rolls the cache back on failure. Drives the REAL saveMilestones via AppProvider + the
// singleton queryClient — mirrors loanFactsWrite.provider.screen.test.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { AppProvider, useAppContext } from '../context';
import type { MilestoneRecord } from '../api';
import { queryClient } from '../queryClient';

jest.mock('../api');
jest.mock('../auth', () => ({ getStatus: () => 'authed', subscribe: () => () => {} }));
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

const PLAN: MilestoneRecord[] = [
  { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
  { id: 'b', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
];
const cached = () => queryClient.getQueryData<MilestoneRecord[]>(['milestones']);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData(['milestones'], []); // the "no saved plan yet" starting point
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveMilestones writes the cache + invalidates ONLY milestones', async () => {
  mockApi.setMilestones.mockResolvedValue(PLAN);
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveMilestones(PLAN); });

  expect(ok).toBe(true);
  expect(cached()).toEqual(PLAN); // optimistic write
  const keys = invalidateSpy.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  expect(keys).toContain('milestones');
  expect(keys).not.toContain('homeLoan');   // the balance read must not be disturbed
  expect(keys).not.toContain('loanFacts');
  invalidateSpy.mockRestore();
});

it('rolls the cache back to the prior plan on a save failure', async () => {
  mockApi.setMilestones.mockRejectedValue(new Error('boom'));
  const result = mount();

  // The optimistic write reaches the cache MID-FLIGHT (before the reject), then the catch rolls it
  // back to the pre-save []. The mid check keeps teeth: without the optimistic write mid stays empty.
  let midLength: number | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveMilestones(PLAN);
    midLength = cached()?.length; // optimistic → 2
    ok = await p;
  });

  expect(ok).toBe(false);
  expect(midLength).toBe(2);        // <-- fails if the optimistic write is removed
  expect(cached()).toEqual([]);     // rolled back to the pre-save (empty) plan
});
