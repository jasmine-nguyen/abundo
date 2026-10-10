// WHIT-377 — saveMilestones optimistically writes the ['milestones'] query cache (the milestone +
// mortgage screens read it), PUTs the whole list, then invalidates that key so the screen refreshes
// (milestones is out of the read composite's refetch, so the save's own invalidate is what updates
// it), and rolls the cache back on failure; a save that settles after sign-out is a no-op. Drives
// the REAL saveMilestones via AppProvider + the singleton queryClient — mirrors
// loanFactsWrite.provider.screen.test.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { MilestoneRecord } from '../api';
import { SAVED_MILESTONES } from './support/milestonePlan';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { invalidatedKeys } from './support/queryClient';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();

const cached = () => queryClient.getQueryData<MilestoneRecord[]>(['milestones']);

beforeEach(() => { resetAuth(); });
afterEach(() => { queryClient.clear(); });

function mount() {
  queryClient.setQueryData(['milestones'], []); // the "no saved plan yet" starting point
  const { result } = renderHook(() => useAppContext(), { wrapper });
  return result;
}

it('saveMilestones writes the cache + invalidates milestones', async () => {
  const result = mount();
  const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

  let ok: boolean | undefined;
  await act(async () => { ok = await result.current.saveMilestones(SAVED_MILESTONES); });

  expect(ok).toBe(true);
  expect(server.requests()).toContainEqual({ method: 'PUT', path: '/milestones', body: { milestones: SAVED_MILESTONES } });
  expect(cached()).toEqual(SAVED_MILESTONES); // optimistic write
  expect(invalidatedKeys(invalidateSpy)).toContain('milestones');
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

// WHIT-271 parity: a save that settles AFTER the session ends must not re-seat the old plan into the
// cleared cache, toast into the next session, or return true (that would fire the editor's
// router.back() after the login redirect).
describe('WHIT-377 — saveMilestones settling AFTER sign-out is a no-op', () => {
  // Sign out in PRODUCTION order: clear the cache, THEN broadcast anon (which the context
  // subscription turns into the session epoch bump).
  const signOut = () => { act(() => { queryClient.clear(); setAuthStatus('anon'); }); };
  const PREV = SAVED_MILESTONES.slice(0, 2);
  const NEXT = SAVED_MILESTONES;

  it('SUCCESS after sign-out: no invalidate re-seat, no toast, returns false', async () => {
    queryClient.setQueryData(['milestones'], PREV);
    const held = server.hold('/milestones'); // the save is genuinely in flight when the session ends
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveMilestones(NEXT); }); // optimistic write → cache = NEXT
    signOut();                                                      // clears cache + bumps epoch
    let returned!: boolean;
    await act(async () => { held.release(); returned = await pending; });

    expect(returned).toBe(false);              // <-- no stray router.back() after the login redirect
    expect(cached()).toBeUndefined();          // the cleared cache is NOT re-populated by a late invalidate/write
    expect(result.current.toast).toBeNull();
  });

  it('FAILURE after sign-out: old plan is NOT re-seated into the cleared cache, no toast, returns false', async () => {
    queryClient.setQueryData(['milestones'], PREV);
    const held = server.hold('/milestones'); // the save is genuinely in flight when the session ends
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<boolean>;
    act(() => { pending = result.current.saveMilestones(NEXT); });
    signOut();
    let returned!: boolean;
    await act(async () => { held.fail('PUT'); returned = await pending; });

    expect(returned).toBe(false);
    expect(cached()).toBeUndefined();          // <-- the catch's setQueryData(prev) is skipped by the epoch guard
    expect(result.current.toast).toBeNull();   // no "Could not save milestones" into the next session
  });
});
