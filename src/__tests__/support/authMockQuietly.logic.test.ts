// WHIT-786 (slice 2) — the shared sign-in switch can change status quietly. Some suites flip the
// status mid-test WITHOUT telling subscribers (the screen must not react yet); others re-announce
// the current status to make the screen re-read it. Both now go through support/authMock.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { getAuthStatus, subscribeAuth, setAuthStatus, setAuthStatusQuietly, resetAuth } from './authMock';

beforeEach(() => resetAuth());

describe('WHIT-786 shared sign-in switch: quiet change and rebroadcast', () => {
  it('a test can change the status quietly, then rebroadcast it to subscribers', () => {
    const listener = jest.fn();
    subscribeAuth(listener);

    setAuthStatusQuietly('locked');
    expect(getAuthStatus()).toBe('locked');
    expect(listener).not.toHaveBeenCalled();

    setAuthStatusQuietly('anon');
    expect(getAuthStatus()).toBe('anon');
    expect(listener).not.toHaveBeenCalled();

    setAuthStatus(getAuthStatus());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getAuthStatus()).toBe('anon');

    resetAuth();
    expect(getAuthStatus()).toBe('authed');
  });
});
