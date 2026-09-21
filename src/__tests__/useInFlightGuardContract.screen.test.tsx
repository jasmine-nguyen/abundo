// WHIT-249 — useInFlightGuard error-contract GAPS. Additive to the implementer's
// [G-swallow] (sync `throw new Error`), [G-throw] (immediately-rejected promise) and
// [G-syncthrow]. These lock three edges those do NOT touch: a NON-Error rejection value
// (+ the exact log shape), the same-frame double-tap DROP surviving a doomed async write,
// and a rejection that lands AFTER an await (a real async hop, not a sync throw).
import { it, expect, jest, afterEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { useInFlightGuard } from '../hooks/useInFlightGuard';

// Restore any per-test console.error spy even if a test fails mid-body (a trailing mockRestore()
// would be skipped on an earlier assertion failure, leaking the silence into later tests).
afterEach(() => { jest.spyOn(console, 'error').mockRestore(); });

// [G-nonerror] The catch binds ANY thrown value, not just Error instances. An action that rejects
// with a bare string must STILL resolve (no unhandled rejection), and the guard must log the raw
// value through for debugging. Asserting the exact (message, value) pair also pins the WHIT-249
// log contract itself. Fail-on-revert: delete the hook's `catch` → run() rejects with the raw
// string → the bare `await` throws out of `act` → this fails.
it('[G-nonerror] swallows a non-Error (string) rejection, logs the raw value, resolves + releases', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(() => Promise.reject('plain string reason'));
  const retry = jest.fn(() => Promise.resolve());

  // No `.catch()`: the promise MUST resolve, or this `await` throws.
  await act(async () => { await result.current(boom); });
  expect(boom).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith('[useInFlightGuard] guarded action threw', 'plain string reason');

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});

// [G-dropmidthrow] The core double-write guard must hold even when the in-flight action is DOOMED
// to reject. A doomed async write (still pending) holds the latch across its await, so a same-frame
// SECOND tap is dropped → the writer runs ONCE, not twice. Then the write rejects and the new catch
// path releases the latch so a later retry runs. This is the FAILING-save version of the same-frame
// guarantee, which [G-throw] (rejects immediately, one call) never exercises.
// Fail-on-revert (drop): delete `if (inFlight.current) return` → the second same-frame call
// (`retry`) fires while `boom` is still pending → `expect(retry).not.toHaveBeenCalled()` fails.
// Fail-on-revert (release): revert the finally to a post-await reset → the rejection skips the
// reset → the final retry never fires.
it('[G-dropmidthrow] drops the same-frame second call while an async action is mid-flight, then releases on reject', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  let rejectFirst!: (e: unknown) => void;
  const boom = jest.fn(() => new Promise((_, reject) => { rejectFirst = reject; }));
  const retry = jest.fn(() => Promise.resolve());

  // Two synchronous same-frame calls; the first is still PENDING (not yet rejected).
  await act(async () => {
    result.current(boom);
    result.current(retry);
  });
  expect(boom).toHaveBeenCalledTimes(1);
  expect(retry).not.toHaveBeenCalled();

  // The in-flight write now rejects → caught + logged → latch released.
  await act(async () => { rejectFirst(new Error('late fail')); });
  expect(errorSpy).toHaveBeenCalledWith('[useInFlightGuard] guarded action threw', expect.any(Error));

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});

// [G-asyncreject] A real async action that awaits and THEN throws (vs a sync throw or an
// immediately-rejected promise) must still funnel through the new catch: resolve, log, release.
// Guards that the catch covers the post-suspend path, not just the synchronous portion.
// Fail-on-revert: delete the hook's `catch` → the delayed rejection escapes → bare `await` throws.
it('[G-asyncreject] swallows a rejection that lands after an await (resolves, logs, releases)', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() => useInFlightGuard());
  const boom = jest.fn(async () => {
    await Promise.resolve();            // a genuine async hop first
    throw new Error('post-await boom');
  });
  const retry = jest.fn(() => Promise.resolve());

  await act(async () => { await result.current(boom); });
  expect(boom).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledWith('[useInFlightGuard] guarded action threw', expect.any(Error));

  await act(async () => { result.current(retry); });
  expect(retry).toHaveBeenCalledTimes(1);
});
