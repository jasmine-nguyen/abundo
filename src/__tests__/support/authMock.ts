// WHIT-456 (slice 2 of WHIT-451) — shared stand-in for the live login store, extracted from the
// ~identical block copied across the overlays/session screen suites. It fakes src/auth's
// getStatus/subscribe as a live store a test can drive, so a screen's useIsAuthed() reacts to
// authed→locked→anon transitions exactly as in prod. Usage in a suite:
//
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   import { setAuthStatus, resetAuth } from './support/authMock';
//   beforeEach(() => resetAuth());
//   ...
//   act(() => setAuthStatus('locked'));
//
// The real query hooks read this same store, so draw the screen with support/renderWithQueries.
// The jest.mock factory uses require() (not the import) so it survives hoisting; every path
// resolves to this one module instance, so setAuthStatus() and the real useIsAuthed share state.
//
// NOTE: setAuthStatus broadcasts UNCONDITIONALLY. The guarded variant — skip the broadcast when
// the status is unchanged (sessionEpochAccessor / session-epoch suites) — is deliberately NOT
// covered here; those suites keep their inlined block.
import type { AuthStatus } from '../../auth';

const TEST_TOKEN = 'test-id-token';

let status: AuthStatus = 'authed';
let token: string | undefined = TEST_TOKEN;
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

// The ID token the real api.ts request step asks for (WHIT-637). undefined → "Not signed in".
export const getAuthToken = async (): Promise<string | undefined> => token;

export const setAuthToken = (next: string | undefined): void => {
  token = next;
};

// Reset to logged-in (with a token) + drop stale subscribers. Call in beforeEach.
export const resetAuth = (): void => {
  status = 'authed';
  token = TEST_TOKEN;
  listeners.clear();
};

// The object for jest.mock('../auth', ...): the three functions the app reads from the auth
// module. The `satisfies` anchors the shape to the real auth module, so a signature drift trips
// typecheck instead of silently diverging.
export function authMockModule() {
  return { getStatus: getAuthStatus, subscribe: subscribeAuth, getAuthToken } satisfies Pick<
    typeof import('../../auth'),
    'getStatus' | 'subscribe' | 'getAuthToken'
  >;
}

// The live useIsAuthed override for the ../queries mock, wired to the same store — mirrors
// queries.ts: useSyncExternalStore(subscribe, () => getStatus() === 'authed'). require('react')
// stays inside the body so it is safe under jest.mock hoisting.
export function useIsAuthedMock(): boolean {
  const React = require('react');
  return React.useSyncExternalStore(subscribeAuth, () => status === 'authed');
}
