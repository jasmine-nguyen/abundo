// WHIT-241 — useInFlightGuard, the synchronous in-flight latch behind the category
// create/save double-tap guard. renderHook lets us invoke `run` TWICE synchronously in one
// tick — a genuine same-frame double-tap. fireEvent CAN'T reproduce this: RTL flushes a
// re-render between two press events, which is exactly why the duplicate-create bug slips
// past normal screen tests. We test the latch directly instead.
import { it, expect, jest, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useInFlightGuard } from '../hooks/useInFlightGuard';

// Restore any per-test console.error spy even if a test fails mid-body (a trailing mockRestore()
// would be skipped on an earlier assertion failure, leaking the silence into later tests).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

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
// and a thrown action leaves the latch stuck → `retry` never fires. The guard now catches +
// logs the rejection (WHIT-249), so silence console.error to keep the output clean.
it('releases the latch when the action throws (retry still works)', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(() => Promise.reject(new Error('save failed')));
  const retry = jest.fn(() => Promise.resolve());

  await act(async () => { await result.current(boom); });
  expect(boom).toHaveBeenCalledTimes(1);

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});

// ===== WHIT-241 adversarial gaps (folded in): the SYNCHRONOUS-void and sync-throw host paths =====

// [G-syncvoid] The ＋New sub-category path: action returns VOID (not a promise). Two same-frame
// calls must still run it ONCE, and — because `await undefined` resolves on the next microtask —
// the `finally` must release so a LATER press runs again. Fail-on-revert: delete
// `if (inFlight.current) return` → the first assertion goes 1 → 2 (both same-frame calls fire).
it('drops a same-frame second call for a synchronous void action, then re-enables', async () => {
  const { result } = renderHook(() => useInFlightGuard());
  const action = jest.fn(() => { /* returns void, like the sub-add onSubmit */ });

  // Two SYNCHRONOUS calls in one tick — the same-frame double-tap.
  await act(async () => {
    result.current(action);
    result.current(action);
  });
  expect(action).toHaveBeenCalledTimes(1);

  // Latch released after the (void) action settled → a later press runs again.
  await act(async () => { result.current(action); });
  expect(action).toHaveBeenCalledTimes(2);
});

// [G-syncthrow] An action that throws SYNCHRONOUSLY (before returning a promise) is a different
// code path from the implementer's rejected-promise [G-throw]: the throw fires while `action()`
// is being evaluated inside the try, not from an awaited rejection. `finally` must still release
// the latch so a retry works. Fail-on-revert: swap the `finally` for a post-`await` reset line
// and this sync throw skips the reset → `retry` never fires (stays latched). The guard now
// catches + logs the throw (WHIT-249), so silence console.error to keep the output clean.
it('releases the latch when the action throws synchronously (retry still works)', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(() => { throw new Error('sync boom'); });
  const retry = jest.fn(() => Promise.resolve());

  await act(async () => { await result.current(boom); });
  expect(boom).toHaveBeenCalledTimes(1);

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});

// [G-swallow] The WHIT-249 error contract: a guarded action that throws must NOT surface as an
// unhandled promise rejection. The guard catches it, logs via console.error, and the returned
// promise RESOLVES — callers never need to `.catch()`. The latch still releases so a retry runs.
// Fail-on-revert: remove the `catch` in the hook → `run()` rejects again → the bare `await` throws
// out of `act` and the test fails (and the console.error assertion no longer holds).
it('swallows a thrown action: resolves (not rejects), logs it, and re-enables', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(() => { throw new Error('boom'); });
  const retry = jest.fn(() => Promise.resolve());

  // No `.catch()` here on purpose: the promise must resolve, or this `await` would throw.
  await act(async () => { await result.current(boom); });
  expect(boom).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith('[useInFlightGuard] guarded action threw', expect.any(Error));

  // Latch released after the swallowed throw → a later press runs again.
  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});
