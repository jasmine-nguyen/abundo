// WHIT-241 — useInFlightGuard, the synchronous in-flight latch behind the category
// create/save double-tap guard. renderHook lets us invoke `run` TWICE synchronously in one
// tick — a genuine same-frame double-tap. fireEvent CAN'T reproduce this: RTL flushes a
// re-render between two press events, which is exactly why the duplicate-create bug slips
// past normal screen tests. We test the latch directly instead.
import { it, expect, jest } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useInFlightGuard } from '../hooks/useInFlightGuard';

// [G-latch] The core guarantee: two same-frame calls → the action runs ONCE.
// Fail-on-revert: delete the `if (inFlight.current) return` line and the second call fires,
// making this expect(1) go to 2.
it('runs the action once when fired twice in the same frame (drops the second)', async () => {
  const { result } = renderHook(() => useInFlightGuard());
  const action = jest.fn(() => new Promise<void>(() => {})); // stays in-flight forever
  await act(async () => {
    // Two SYNCHRONOUS calls in one tick — the same-frame double-tap the bug needs.
    result.current(action);
    result.current(action);
  });
  expect(action).toHaveBeenCalledTimes(1);
});

// [G-reset] While an action is in flight the button is latched; once it SETTLES the latch
// releases so the next press works. Guards the disabled-then-re-enabled behaviour.
it('re-enables once the in-flight action settles', async () => {
  const { result } = renderHook(() => useInFlightGuard());
  let resolveFirst!: () => void;
  const first = jest.fn(() => new Promise<void>((r) => { resolveFirst = r; }));
  const second = jest.fn(() => Promise.resolve());

  await act(async () => { result.current(first); });
  expect(first).toHaveBeenCalledTimes(1);

  // Second press while `first` is still running → blocked.
  await act(async () => { result.current(second); });
  expect(second).not.toHaveBeenCalled();

  // `first` settles → latch releases → a later press runs.
  await act(async () => { resolveFirst(); });
  await act(async () => { result.current(second); });
  expect(second).toHaveBeenCalledTimes(1);
});

// [G-throw] A FAILING action must still release the latch (via `finally`), so a save that
// errored can be retried. Fail-on-revert: change the `finally` to a plain post-await reset
// and a thrown action leaves the latch stuck → `retry` never fires.
it('releases the latch when the action throws (retry still works)', async () => {
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(() => Promise.reject(new Error('save failed')));
  const retry = jest.fn(() => Promise.resolve());

  await act(async () => { await result.current(boom).catch(() => {}); });
  expect(boom).toHaveBeenCalledTimes(1);

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});
