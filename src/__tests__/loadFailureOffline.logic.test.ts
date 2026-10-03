// WHIT-713 — the rule that sorts a failed read into "you look offline" vs "our server had a
// problem". Only a lost connection (fetch's TypeError) or our own timeout (AbortError) counts as
// offline; anything with a server status, a sign-in problem or a bad body is not.
import { describe, it, expect } from '@jest/globals';
import { ApiError, readFailureIsOffline, loadFailureReason } from '../apiError';

const OFFLINE = 'You look offline. Check your connection and retry.';
const SERVER = 'Our server had a problem. Try again in a moment.';

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

describe('readFailureIsOffline', () => {
  it('a lost connection or a timeout looks offline', () => {
    expect(readFailureIsOffline(new TypeError('Network request failed'))).toBe(true);
    expect(readFailureIsOffline(abortError())).toBe(true);
  });

  it('a server reply, a sign-in problem or a bad body does not look offline', () => {
    expect(readFailureIsOffline(new Error('API error: 503'))).toBe(false);
    expect(readFailureIsOffline(new ApiError(500, null))).toBe(false);
    expect(readFailureIsOffline(new Error('Not signed in'))).toBe(false);
    expect(readFailureIsOffline(new SyntaxError('x'))).toBe(false);
  });
});

describe('loadFailureReason', () => {
  it('gives the offline sentence for a lost connection or a timeout', () => {
    expect(loadFailureReason(new TypeError('Network request failed'))).toBe(OFFLINE);
    expect(loadFailureReason(abortError())).toBe(OFFLINE);
  });

  it('gives the server sentence for a server error', () => {
    expect(loadFailureReason(new Error('API error: 503'))).toBe(SERVER);
    expect(loadFailureReason(new ApiError(500, 'boom'))).toBe(SERVER);
  });
});
