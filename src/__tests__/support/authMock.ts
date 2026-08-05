// WHIT-456 (slice 2 of WHIT-451) — shared stand-in for the live login store, extracted from the
// ~identical block copied across the overlays/session screen suites. It fakes src/auth's
// getStatus/subscribe as a live store a test can drive, so a screen's useIsAuthed() reacts to
// authed→locked→anon transitions exactly as in prod. Usage in a suite:
//
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   jest.mock('../queries', () => ({
//     ...require('./support/screenQueryMocks').queryMocksFromState(() => mockState),
//     useIsAuthed: () => require('./support/authMock').useIsAuthedMock(), // AFTER the spread
//   }));
//   import { setAuthStatus, resetAuth } from './support/authMock';
//   beforeEach(() => resetAuth());
//   ...
//   act(() => setAuthStatus('locked'));
//
// Both jest.mock factories use require() (not the import) so they survive hoisting; every path
// resolves to this one module instance, so setAuthStatus() and the mocked hooks share state.
//
// NOTE: setAuthStatus broadcasts UNCONDITIONALLY. The guarded variant — skip the broadcast when
// the status is unchanged (sessionEpochAccessor / session-epoch suites) — is deliberately NOT
// covered here; those suites keep their inlined block.
import type { AuthStatus } from '../../auth';

let status: AuthStatus = 'authed';
const listeners = new Set<() => void>();

export const getAuthStatus = (): AuthStatus => status;

export const subscribeAuth = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Flip the login status mid-test and notify subscribers, like auth.ts setStatus.
export const setAuthStatus = (next: AuthStatus): void => {
  status = next;
  listeners.forEach((listener) => listener());
};

// Reset to logged-in + drop stale subscribers. Call in beforeEach.
export const resetAuth = (): void => {
  status = 'authed';
  listeners.clear();
};

// The object for jest.mock('../auth', ...): the two functions the auth module exposes. The
// `satisfies` anchors the shape to the real auth module, so a getStatus/subscribe signature
// drift trips typecheck instead of silently diverging.
export function authMockModule() {
  return { getStatus: getAuthStatus, subscribe: subscribeAuth } satisfies Pick<
    typeof import('../../auth'),
    'getStatus' | 'subscribe'
  >;
}

// The live useIsAuthed override for the ../queries mock, wired to the same store — mirrors
// queries.ts: useSyncExternalStore(subscribe, () => getStatus() === 'authed'). require('react')
// stays inside the body so it is safe under jest.mock hoisting.
export function useIsAuthedMock(): boolean {
  const React = require('react');
  return React.useSyncExternalStore(subscribeAuth, () => status === 'authed');
}
