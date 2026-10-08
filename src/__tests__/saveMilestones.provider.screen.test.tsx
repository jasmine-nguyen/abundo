// WHIT-377 — saveMilestones optimistically writes the ['milestones'] query cache (the milestone +
// mortgage screens read it), PUTs the whole list, then invalidates that key so the screen refreshes
// (milestones is out of the read composite's refetch, so the save's own invalidate is what updates
// it), and rolls the cache back on failure. Drives the REAL saveMilestones via AppProvider + the
// singleton queryClient — mirrors loanFactsWrite.provider.screen.test.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { MilestoneRecord } from '../api';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const cached = () => queryClient.getQueryData<MilestoneRecord[]>(['milestones']);

beforeEach(() => { queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData(['milestones'], []); // the "no saved plan yet" starting point
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveMilestones writes the cache + invalidates ONLY milestones', async () => {
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveMilestones(SAVED_MILESTONES); });

  expect(ok).toBe(true);
  expect(server.requests()).toContainEqual({ method: 'PUT', path: '/milestones', body: { milestones: SAVED_MILESTONES } });
  expect(cached()).toEqual(SAVED_MILESTONES); // optimistic write
  const keys = invalidatedKeys(invalidateSpy);
  expect(keys).toContain('milestones');
  expect(keys).not.toContain('homeLoan');   // the balance read must not be disturbed
  expect(keys).not.toContain('loanFacts');
  invalidateSpy.mockRestore();
});

it('rolls the cache back to the prior plan on a save failure', async () => {
  server.fail('/milestones', 500);
  const result = mount();

  // The optimistic write reaches the cache MID-FLIGHT (before the reject), then the catch rolls it
  // back to the pre-save []. The mid check keeps teeth: without the optimistic write mid stays empty.
  let midLength: number | undefined;
  let ok: boolean | undefined;
  await act(async () => {
    const p = result.current.saveMilestones(SAVED_MILESTONES);
    midLength = cached()?.length; // optimistic → the full plan
    ok = await p;
  });

  expect(ok).toBe(false);
  expect(midLength).toBe(SAVED_MILESTONES.length); // <-- fails if the optimistic write is removed
  expect(cached()).toEqual([]);     // rolled back to the pre-save (empty) plan
});
