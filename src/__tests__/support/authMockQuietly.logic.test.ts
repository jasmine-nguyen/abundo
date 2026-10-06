// WHIT-786 — setAuthStatusQuietly changes the status without telling subscribers. No suite that
// uses it would notice if it started broadcasting, so pin that here.
import { it, expect, jest } from '@jest/globals';
import { getAuthStatus, subscribeAuth, setAuthStatusQuietly, resetAuth } from './authMock';

it('a quiet status change does not notify subscribers', () => {
  resetAuth();
  const listener = jest.fn();
  subscribeAuth(listener);

  setAuthStatusQuietly('locked');

  expect(getAuthStatus()).toBe('locked');
  expect(listener).not.toHaveBeenCalled();
});
