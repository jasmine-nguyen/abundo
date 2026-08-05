// WHIT-456 (slice 2 of WHIT-451) — unit contract for support/authMock's store primitives.
// The screen adopters (overlaysSheetDraft) already pin useIsAuthedMock reacting through a real
// render; this suite pins the raw store contract they DON'T assert directly:
//   [A5] setAuthStatus broadcasts UNCONDITIONALLY (even to a same-value transition)
//   [A6] subscribeAuth's returned unsubscribe actually removes the listener
//   [A7] resetAuth clears listeners (a leftover subscriber from a prior test never fires)
//   [A8] resetAuth resets status back to 'authed'
//   [A9] authMockModule() getStatus/subscribe are wired to the SAME singleton store
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  getAuthStatus,
  subscribeAuth,
  setAuthStatus,
  resetAuth,
  authMockModule,
} from './authMock';

beforeEach(() => resetAuth());

describe('WHIT-456 authMock store contract', () => {
  it('[A5] setAuthStatus broadcasts UNCONDITIONALLY, including a no-change transition', () => {
    // Real auth.setStatus early-returns when next === status; this fake must NOT — the
    // adopters rely on every setAuthStatus firing subscribers.
    const listener = jest.fn();
    subscribeAuth(listener);
    setAuthStatus('authed'); // already 'authed' after resetAuth — the no-change case
    expect(listener).toHaveBeenCalledTimes(1);
    setAuthStatus('locked');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getAuthStatus()).toBe('locked');
  });

  it('[A5] broadcasts to EVERY registered listener', () => {
    const a = jest.fn();
    const b = jest.fn();
    subscribeAuth(a);
    subscribeAuth(b);
    setAuthStatus('anon');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('[A6] the unsubscribe returned by subscribeAuth removes that listener', () => {
    const listener = jest.fn();
    const unsub = subscribeAuth(listener);
    unsub();
    setAuthStatus('locked');
    expect(listener).not.toHaveBeenCalled();
  });

  it('[A7] resetAuth clears listeners so a leftover subscriber never fires afterwards', () => {
    const stale = jest.fn();
    subscribeAuth(stale);
    resetAuth();
    setAuthStatus('locked'); // stale must be gone — this simulates cross-test leakage
    expect(stale).not.toHaveBeenCalled();
  });

  it('[A8] resetAuth resets status back to authed', () => {
    setAuthStatus('anon');
    expect(getAuthStatus()).toBe('anon');
    resetAuth();
    expect(getAuthStatus()).toBe('authed');
  });

  it('[A9] authMockModule getStatus/subscribe share the singleton store', () => {
    const mod = authMockModule();
    const listener = jest.fn();
    const unsub = mod.subscribe(listener);
    setAuthStatus('locked'); // driven via the named export...
    expect(listener).toHaveBeenCalledTimes(1); // ...seen by the module-factory subscribe
    expect(mod.getStatus()).toBe('locked'); // ...and by the module-factory getStatus
    unsub();
    setAuthStatus('anon');
    expect(listener).toHaveBeenCalledTimes(1); // module-factory unsubscribe also honoured
  });
});
