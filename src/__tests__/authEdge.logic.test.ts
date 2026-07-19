// WHIT-160 — ADVERSARIAL gap tests for src/auth.ts (not covered by auth.logic.test.ts).
// Covers: session present but idToken undefined (openid scope missing) -> refresh path;
// rotated refresh-token IS persisted, non-rotated leaves the stored token untouched;
// single-flight guard is CLEARED after a failed refresh so a later call retries (no
// wedge); signIn where exchangeCodeAsync throws leaves nothing stored.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'test-verifier';
    promptAsync = mockPromptAsync;
  },
  exchangeCodeAsync: (...a: unknown[]) => mockExchange(...a),
  refreshAsync: (...a: unknown[]) => mockRefresh(...a),
}));

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  deleteItemAsync: jest.fn(async (k: string) => { mockStore.delete(k); }),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
const nowSec = () => Math.floor(Date.now() / 1000);

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

beforeEach(() => {
  jest.resetModules();
  mockStore.clear();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockRefresh.mockReset();
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
});

describe('getAuthToken — session present but no idToken (openid scope missing)', () => {
  it('does NOT return an undefined idToken; falls through to a refresh', async () => {
    // signIn with a token that carries NO idToken (e.g. openid scope dropped).
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue({ accessToken: 'ACC', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await auth.signIn();

    mockRefresh.mockResolvedValue({ idToken: 'RECOVERED_ID', accessToken: 'a2', issuedAt: nowSec(), expiresIn: 3600 });
    // The cached session has idToken===undefined, so getAuthToken must not hand it
    // back; it refreshes and returns the recovered id token.
    await expect(auth.getAuthToken()).resolves.toBe('RECOVERED_ID');
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('refresh-token rotation persistence', () => {
  it('PERSISTS a rotated refresh token returned by refreshAsync', async () => {
    mockStore.set(REFRESH_KEY, 'OLD_REFRESH');
    mockRefresh.mockResolvedValue({
      idToken: 'ID', accessToken: 'a', refreshToken: 'ROTATED_REFRESH', issuedAt: nowSec(), expiresIn: 3600,
    });
    const auth = loadAuth();
    await auth.getAuthToken();
    expect(mockStore.get(REFRESH_KEY)).toBe('ROTATED_REFRESH');
  });

  it('LEAVES the stored refresh token untouched when refreshAsync omits one (Cognito default)', async () => {
    mockStore.set(REFRESH_KEY, 'KEEP_ME');
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'a', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await auth.getAuthToken();
    expect(mockStore.get(REFRESH_KEY)).toBe('KEEP_ME');
  });
});

describe('single-flight is cleared after a failure (no wedge)', () => {
  it('a later getAuthToken retries after the first refresh fails', async () => {
    mockStore.set(REFRESH_KEY, 'R');
    mockRefresh.mockRejectedValueOnce(new Error('network'));
    mockRefresh.mockResolvedValueOnce({ idToken: 'SECOND_TRY', accessToken: 'a', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    // First call: refresh throws -> undefined, session cleared, in-flight released.
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    // A stored token is still present, so a subsequent call must fire a NEW refresh.
    await expect(auth.getAuthToken()).resolves.toBe('SECOND_TRY');
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('signIn — exchange throws after a successful prompt', () => {
  it('returns false and stores nothing when exchangeCodeAsync rejects', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockRejectedValue(new Error('token endpoint 500'));
    const auth = loadAuth();
    await expect(auth.signIn()).resolves.toBe(false);
    expect(mockStore.size).toBe(0);
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });
});
