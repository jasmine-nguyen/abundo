// WHIT-456 (slice 2 of WHIT-451) — shared stand-in for expo-router, extracted from the recurring
// mock copied across the screen suites. Covers the common surface: useRouter (push/back/replace/
// dismissAll spies), useLocalSearchParams, and the run-on-mount useFocusEffect. Usage in a suite:
//
//   jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
//   import { routerSpies, setParams, resetRouter } from './support/routerMock';
//   beforeEach(() => resetRouter());
//   ...
//   expect(routerSpies.push).toHaveBeenCalledWith('/budget/pick');
//
// The jest.mock factory uses require() (not the import) so it survives hoisting; both resolve to
// this one module instance, so routerSpies/setParams and the mock share state.
//
// Deliberately NOT covered — the non-trivial auth-gate/redirect variants, which stay inlined:
// Redirect, useSegments, usePathname, useRootNavigationState, and the no-op useFocusEffect form.
import { jest } from '@jest/globals';

const router = {
  push: jest.fn(),
  back: jest.fn(),
  replace: jest.fn(),
  dismissAll: jest.fn(),
};
let params: Record<string, unknown> = {};

// The spies, for assertions: routerSpies.push.toHaveBeenCalledWith(...).
export const routerSpies = router;

// Set the useLocalSearchParams return for the current test.
export const setParams = (next: Record<string, unknown>): void => { params = next; };

// Clear spy calls + params. Call in beforeEach.
export const resetRouter = (): void => {
  router.push.mockReset();
  router.back.mockReset();
  router.replace.mockReset();
  router.dismissAll.mockReset();
  params = {};
};

// The object for jest.mock('expo-router', ...). Mirrors the inlined mock the screen suites use:
// useFocusEffect runs its callback via useEffect keyed on [callback] — so it re-runs whenever the
// screen passes a fresh callback, and a cleanup the callback returns runs on unmount, faithful to
// real expo-router. (Not type-anchored to expo-router: useRouter returns a deliberate subset of
// Router — only the methods screens use — so a `satisfies` against the full type can't hold.)
export function routerMockModule() {
  const React = require('react');
  return {
    useRouter: () => router,
    useLocalSearchParams: () => params,
    useFocusEffect: (callback: () => void) => React.useEffect(() => callback(), [callback]),
  };
}
