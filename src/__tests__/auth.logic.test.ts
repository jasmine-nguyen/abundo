// WHIT-160 — unit tests for the Cognito auth module (src/auth.ts). The native
// modules (expo-auth-session, expo-secure-store, expo-web-browser) are mocked; no
// browser, no keychain, no network. Covers: sign-in happy/cancel/error, the
// ID-token selection (NOT the access token — the WHIT-97 authorizer contract),
// silent refresh with a single-flight guard, the near-expiry skew buffer, sign-out,
// restoreSession, and the pure gateRedirect decision.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockMakeRedirect = jest.fn(() => 'acme://oauthredirect');
const mockAuthRequest = class {
  codeVerifier = 'test-verifier';
  promptAsync = mockPromptAsync;
  constructor(public config: unknown) {}
};

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: (...a: unknown[]) => mockMakeRedirect(...(a as [])),
  ResponseType: { Code: 'code' },
  AuthRequest: mockAuthRequest,
  exchangeCodeAsync: (...a: unknown[]) => mockExchange(...a),
  refreshAsync: (...a: unknown[]) => mockRefresh(...a),
}));

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockOpenAuthSession = jest.fn<(url: string, redirect: string) => Promise<{ type: string }>>(
  async () => ({ type: 'dismiss' }),
);
jest.mock('expo-web-browser', () => ({
  openAuthSessionAsync: (...a: unknown[]) => mockOpenAuthSession(...(a as [string, string])),
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const DOMAIN = 'https://whittle-auth.auth.ap-southeast-2.amazoncognito.com';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Re-require a fresh module each test so its in-memory session/status singletons
// don't leak between cases.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
function loadAuth(): typeof import('../auth') {
  return require('../auth');
}

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

describe('signIn', () => {
  it('exchanges the code (with the PKCE verifier), stores the refresh token, returns true', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'AUTH_CODE' } });
    mockExchange.mockResolvedValue({
      idToken: 'ID_TOKEN', accessToken: 'ACCESS_TOKEN', refreshToken: 'REFRESH_TOKEN',
      issuedAt: nowSec(), expiresIn: 3600,
    });
    const auth = loadAuth();

    await expect(auth.signIn()).resolves.toBe(true);
    expect(mockExchange).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client123', code: 'AUTH_CODE', extraParams: { code_verifier: 'test-verifier' } }),
      expect.objectContaining({ tokenEndpoint: `${DOMAIN}/oauth2/token` }),
    );
    expect(mockStore.get(REFRESH_KEY)).toBe('REFRESH_TOKEN');
    expect(auth.getStatus()).toBe('authed');
  });

  it('returns false and stores nothing when the user cancels', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'cancel' });
    const auth = loadAuth();

    await expect(auth.signIn()).resolves.toBe(false);
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockStore.size).toBe(0);
  });

  it('never throws when promptAsync rejects', async () => {
    mockPromptAsync.mockRejectedValue(new Error('boom'));
    const auth = loadAuth();
    await expect(auth.signIn()).resolves.toBe(false);
  });

  it('bails (returns false, no browser) when config is missing', async () => {
    delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
    const auth = loadAuth();
    await expect(auth.signIn()).resolves.toBe(false);
    expect(mockPromptAsync).not.toHaveBeenCalled();
  });
});

describe('getAuthToken', () => {
  async function signInWith(token: Record<string, unknown>): Promise<typeof import('../auth')> {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue(token);
    const auth = loadAuth();
    await auth.signIn();
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
});

describe('gateRedirect (pure)', () => {
  const auth = loadAuth();
  it('does nothing when the gate is disabled', () => {
    expect(auth.gateRedirect({ enabled: false, navReady: true, status: 'anon', onIndex: false })).toBeNull();
  });
  it('does nothing before the navigator is mounted', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: false, status: 'anon', onIndex: false })).toBeNull();
  });
  it('does nothing while loading', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: true, status: 'loading', onIndex: false })).toBeNull();
  });
  it('kicks an anon user off a protected route to the login screen', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: true, status: 'anon', onIndex: false })).toBe('/');
  });
  it('leaves an anon user on the login screen (no loop)', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: true, status: 'anon', onIndex: true })).toBeNull();
  });
  it('forwards an authed user off the login screen into the app', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: true, status: 'authed', onIndex: true })).toBe('/(tabs)/budgets');
  });
  it('leaves an authed user inside the app alone', () => {
    expect(auth.gateRedirect({ enabled: true, navReady: true, status: 'authed', onIndex: false })).toBeNull();
  });
});
