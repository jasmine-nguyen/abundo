// WHIT-241 — useInFlightGuard GAPS. The implementer's 3 tests all drive the latch with a
// PROMISE-returning action (never-resolving / resolve / reject). The real hosts include a
// SYNCHRONOUS void onSubmit — the edit screen's "＋ New sub-category" add passes
// `(d) => { setNewChildren(...); setAddingChild(false); }`, which returns undefined, not a
// promise. These probes lock the non-promise paths: `await undefined` must still latch on the
// same frame and release in `finally`, and a SYNCHRONOUS throw (thrown before any promise is
// returned) must still release so retry works. renderHook lets us fire two calls in one tick —
// the genuine same-frame double-tap fireEvent can't reproduce (RTL re-renders between presses).
import { it, expect, jest, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useInFlightGuard } from '../hooks/useInFlightGuard';

// Restore any per-test console.error spy even if a test fails mid-body (a trailing mockRestore()
// would be skipped on an earlier assertion failure, leaking the silence into later tests).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

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
