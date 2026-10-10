// WHIT-160 — unit tests for the Cognito auth module (src/auth.ts). The native
// modules (expo-auth-session, expo-secure-store, expo-web-browser) are mocked; no
// browser, no keychain, no network. Covers: sign-in happy/cancel/error, the
// ID-token selection (NOT the access token — the WHIT-97 authorizer contract),
// silent refresh with a single-flight guard, the near-expiry skew buffer, sign-out,
// restoreSession, and the pure gateRedirect decision.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REFRESH_KEY, loadAuth, nowSec } from './support/authModule';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMakeRedirect = jest.fn(() => 'acme://oauthredirect');
const mockAuthRequest = class {
  codeVerifier = 'test-verifier';
  promptAsync = mockPromptAsync;
  constructor(public config: unknown) {}
};

jest.mock('expo-auth-session', () =>
  require('./support/authModule').authSessionMock({
    exchange: mockExchange,
    refresh: mockRefresh,
    overrides: {
      makeRedirectUri: (...a: unknown[]) => mockMakeRedirect(...(a as [])),
      AuthRequest: mockAuthRequest,
    },
  }),
);

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => require('./support/authModule').memorySecureStoreMock(mockStore));

const mockOpenAuthSession = jest.fn<(url: string, redirect: string) => Promise<{ type: string }>>(
  async () => ({ type: 'dismiss' }),
);
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...a: unknown[]) => mockOpenAuthSession(...(a as [string, string])),
}));

const DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';

beforeEach(() => {
  jest.resetModules();
  mockStore.clear();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockRefresh.mockReset();
  mockOpenAuthSession.mockClear();
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
});

// signInWithGoogle is the sole remaining entry into the Hosted UI PKCE flow (the neutral
// signIn() was removed with WHIT-449 — it had no production caller). These cover the shared
// hostedUiAuthorize behaviour: code exchange, cancel, error, and the missing-config bail.
describe('signInWithGoogle (Hosted UI PKCE flow)', () => {
  it('exchanges the code (with the PKCE verifier), stores the refresh token, returns true', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'AUTH_CODE' } });
    mockExchange.mockResolvedValue({
      idToken: 'ID_TOKEN', accessToken: 'ACCESS_TOKEN', refreshToken: 'REFRESH_TOKEN',
      issuedAt: nowSec(), expiresIn: 3600,
    });
    const auth = loadAuth();

    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: true });
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client123', code: 'AUTH_CODE', extraParams: { code_verifier: 'test-verifier' } }),
      expect.objectContaining({ tokenEndpoint: `${DOMAIN}/oauth2/token` }),
    );
    expect(mockStore.get(REFRESH_KEY)).toBe('REFRESH_TOKEN');
    expect(auth.getStatus()).toBe('authed');
  });

  it.each(['cancel', 'dismiss'])('resolves silently (no error) and stores nothing when the prompt returns %s', async (type) => {
    mockPromptAsync.mockResolvedValue({ type });
    const auth = loadAuth();

    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false });
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockStore.size).toBe(0);
  });

  it('returns the generic failure and stores nothing when exchangeCodeAsync rejects', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockRejectedValue(new Error('token endpoint 500'));
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({
      ok: false,
      error: "Couldn't complete Google sign-in. Please try again.",
    });
    expect(mockStore.size).toBe(0);
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });

  it('bails with a "not set up" error (no browser) when config is missing', async () => {
    delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({
      ok: false,
      error: "Sign-in isn't set up. Check the app configuration.",
    });
    expect(mockPromptAsync).not.toHaveBeenCalled();
  });
});

describe('getAuthToken', () => {
  async function signInWith(token: Record<string, unknown>): Promise<typeof import('../auth')> {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue(token);
    const auth = loadAuth();
    await auth.signInWithGoogle();
    return auth;
  }

  it('returns the ID token — NOT the access token — while it is fresh, without refreshing', async () => {
    const auth = await signInWith({
      idToken: 'THE_ID_TOKEN', accessToken: 'THE_ACCESS_TOKEN', refreshToken: 'R',
      issuedAt: nowSec(), expiresIn: 3600,
    });
    await expect(auth.getAuthToken()).resolves.toBe('THE_ID_TOKEN');
    await expect(auth.getAuthToken()).resolves.not.toBe('THE_ACCESS_TOKEN');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired session from the stored refresh token', async () => {
    const auth = await signInWith({
      idToken: 'OLD_ID', accessToken: 'a', refreshToken: 'STORED_REFRESH',
      issuedAt: nowSec() - 4000, expiresIn: 3600, // already past expiry
    });
    mockRefresh.mockResolvedValue({ idToken: 'FRESH_ID', accessToken: 'a2', issuedAt: nowSec(), expiresIn: 3600 });

    await expect(auth.getAuthToken()).resolves.toBe('FRESH_ID');
    expect(mockRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client123', refreshToken: 'STORED_REFRESH' }),
      expect.objectContaining({ tokenEndpoint: `${DOMAIN}/oauth2/token` }),
    );
  });

  it('returns undefined (no refresh call) when there is no session at all', async () => {
    const auth = loadAuth();
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does NOT return an undefined idToken; falls through to a refresh', async () => {
    const auth = await signInWith({ accessToken: 'ACC', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    mockRefresh.mockResolvedValue({ idToken: 'RECOVERED_ID', accessToken: 'a2', issuedAt: nowSec(), expiresIn: 3600 });
    await expect(auth.getAuthToken()).resolves.toBe('RECOVERED_ID');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('a later getAuthToken retries after the first refresh fails', async () => {
    mockStore.set(REFRESH_KEY, 'R');
    mockRefresh.mockRejectedValueOnce(new Error('network'));
    mockRefresh.mockResolvedValueOnce({ idToken: 'SECOND_TRY', accessToken: 'a', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    await expect(auth.getAuthToken()).resolves.toBe('SECOND_TRY');
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('returns undefined when the refresh fails', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    mockRefresh.mockRejectedValue(new Error('nope'));
    const auth = loadAuth();
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });

  it('single-flights concurrent callers into ONE refresh', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    let resolveRefresh: (v: unknown) => void = () => {};
    mockRefresh.mockReturnValue(new Promise((r) => { resolveRefresh = r; }));
    const auth = loadAuth();

    const calls = [auth.getAuthToken(), auth.getAuthToken(), auth.getAuthToken()];
    resolveRefresh({ idToken: 'ONE', accessToken: 'a', issuedAt: nowSec(), expiresIn: 3600 });
    const results = await Promise.all(calls);

    expect(results).toEqual(['ONE', 'ONE', 'ONE']);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes a token INSIDE the 60s skew buffer', async () => {
    const auth = await signInWith({
      idToken: 'CACHED', accessToken: 'a', refreshToken: 'R',
      issuedAt: nowSec() - 3570, expiresIn: 3600, // expires in ~30s -> within 60s buffer
    });
    mockRefresh.mockResolvedValue({ idToken: 'REFRESHED', accessToken: 'a2', issuedAt: nowSec(), expiresIn: 3600 });
    await expect(auth.getAuthToken()).resolves.toBe('REFRESHED');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('does NOT refresh a token outside the skew buffer', async () => {
    const auth = await signInWith({
      idToken: 'CACHED', accessToken: 'a', refreshToken: 'R',
      issuedAt: nowSec() - 3510, expiresIn: 3600, // expires in ~90s -> outside 60s buffer
    });
    await expect(auth.getAuthToken()).resolves.toBe('CACHED');
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('restoreSession', () => {
  it('re-establishes a session from a stored refresh token', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'a', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
  });

  it('resolves anon when there is no stored token', async () => {
    const auth = loadAuth();
    await expect(auth.restoreSession()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('anon');
  });
});

describe('signOut', () => {
  it('clears the stored token and hits the logout endpoint with logout_uri=acme://signout', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    const auth = loadAuth();
    await auth.signOut();

    expect(mockStore.has(REFRESH_KEY)).toBe(false);
    expect(mockOpenAuthSession).toHaveBeenCalledWith(
      expect.stringContaining('logout_uri=acme%3A%2F%2Fsignout'),
      'acme://signout',
    );
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });

  // WHIT-205: signOut goes through clearSession, which drops the TanStack Query cache — so a
  // different account signing in within the 5-min gcTime can't render this session's rows.
  it('clears the query cache so the next account cannot read this session\'s cached data', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    const auth = loadAuth();
    // The SAME singleton the loaded auth holds — require it post-loadAuth with no intervening
    // resetModules, so it's the exact instance clearSession() clears.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queryClient } = require('../queryClient') as typeof import('../queryClient');
    queryClient.setQueryData(['homeLoan'], { balance: 596642.43, asOf: '2026-07-04' });
    queryClient.setQueryData(['transactions'], [{ transaction_id: 't1' }]);

    await auth.signOut();

    expect(queryClient.getQueryData(['homeLoan'])).toBeUndefined();
    expect(queryClient.getQueryData(['transactions'])).toBeUndefined();
  });

  // The clear is the FIRST statement of signOut, before any await — so a keychain/browser
  // failure below can't leave the previous account's data cached.
  it('clears the cache even when the logout endpoint throws (synchronous, before the await)', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH');
    mockOpenAuthSession.mockRejectedValueOnce(new Error('browser blew up'));
    const auth = loadAuth();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queryClient } = require('../queryClient') as typeof import('../queryClient');
    queryClient.setQueryData(['homeLoan'], { balance: 1, asOf: null });

    await auth.signOut(); // never throws (best-effort logout)

    expect(queryClient.getQueryData(['homeLoan'])).toBeUndefined();
  });
});

// WHIT-205 safety: a same-user re-lock (Face-ID resume) must NOT clear the cache, or every
// unlock would force a full refetch storm of ~9 queries. lock() sets 'locked' directly and
// never routes through clearSession, so the cache survives.
describe('lock (WHIT-205 cache-survival)', () => {
  it('does NOT clear the query cache — the same-user cache must survive a re-lock', () => {
    const auth = loadAuth();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queryClient } = require('../queryClient') as typeof import('../queryClient');
    const homeLoan = { balance: 596642.43, asOf: '2026-07-04' };
    queryClient.setQueryData(['homeLoan'], homeLoan);

    auth.lock();

    expect(auth.getStatus()).toBe('locked');
    expect(queryClient.getQueryData(['homeLoan'])).toEqual(homeLoan); // survived the lock
  });
});

// WHIT-205: clearSession is the SINGLE choke point for every "session gone -> anon" transition
// — NOT just signOut. These lock the OTHER production route into it: a token-refresh FAILURE
// (getAuthToken / restoreSession -> refreshFromStoredToken -> clearSession). If clearSession
// stopped clearing, account A's cached rows would survive the drop-to-login and could render
// under account B on re-auth. Fail-on-revert: remove queryClient.clear() and both assertions flip.
describe('refresh-failure clears the query cache (WHIT-205 choke point)', () => {
  it('getAuthToken -> clearSession on a failed refresh empties the cache and goes anon', async () => {
    mockStore.set(REFRESH_KEY, 'STORED_REFRESH'); // a session exists…
    mockRefresh.mockRejectedValue(new Error('offline')); // …but the refresh fails
    const auth = loadAuth();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { queryClient } = require('../queryClient') as typeof import('../queryClient');
    queryClient.setQueryData(['homeLoan'], { balance: 596642.43, asOf: '2026-07-04' });
    queryClient.setQueryData(['budgets', 14], [{ id: 'coffee' }]);

    await expect(auth.getAuthToken()).resolves.toBeUndefined(); // refresh failed -> no token

    expect(auth.getStatus()).toBe('anon'); // dropped to login…
    expect(queryClient.getQueryData(['homeLoan'])).toBeUndefined(); // …and A's rows are gone
    expect(queryClient.getQueryData(['budgets', 14])).toBeUndefined();
  });
});

describe('gateRedirect (pure)', () => {
  const auth = loadAuth();
  it.each([
    ['before the navigator is mounted', { navReady: false, status: 'anon', onIndex: false }, null],
    ['while loading', { navReady: true, status: 'loading', onIndex: false }, null],
    ['anon on a protected route', { navReady: true, status: 'anon', onIndex: false }, '/'],
    ['anon on the login screen', { navReady: true, status: 'anon', onIndex: true }, null],
    ['authed on the login screen', { navReady: true, status: 'authed', onIndex: true }, '/(tabs)/budgets'],
    ['authed inside the app', { navReady: true, status: 'authed', onIndex: false }, null],
    ['locked', { navReady: true, status: 'locked', onIndex: false }, null],
  ] as const)('%s → %j', (_case, opts, expected) => {
    expect(auth.gateRedirect(opts)).toBe(expected);
  });
});
