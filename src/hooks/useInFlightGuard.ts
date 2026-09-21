import { useCallback, useRef } from 'react';

// WHIT-241: a synchronous in-flight latch for actions fired by a button press.
//
// Returns a stable `run` that executes an action but IGNORES any call arriving while a
// previous one is still in flight. The latch flips synchronously — BEFORE the first await —
// so two native taps landing in the SAME frame (before React re-renders the button into its
// disabled state) can't both fire the action. Without this, a same-frame double-tap on a
// "create"/"save" button reads the still-`false` `submitting`/`busy` flag twice and runs the
// writer twice → duplicate rows.
//
// This is the CORRECTNESS layer; callers keep their own visible `submitting`/`busy` state for
// the disabled-button styling. The latch releases in `finally`, so a failed or early-returning
// action re-enables the button for a retry. `action` may be sync or async — `await` handles both,
// and awaiting means the latch stays held for the whole async op (not just the first tick).
//
// Error contract (WHIT-249): guarded actions own their OWN user-facing error messaging (the
// context writers catch and toast their known failures, returning false/null). This guard catches
// anything that still escapes and logs it, so an unexpected throw becomes a visible dev log —
// never a silent unhandled promise rejection — and the returned promise always resolves. Callers
// therefore never need to `.catch()` it.
export function useInFlightGuard(): (action: () => Promise<unknown> | unknown) => Promise<void> {
  const inFlight = useRef(false);
  return useCallback(async (action: () => Promise<unknown> | unknown) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await action();
    } catch (error) {
      console.error('[useInFlightGuard] guarded action threw', error);
    } finally {
      inFlight.current = false;
    }
  }, []);
}
