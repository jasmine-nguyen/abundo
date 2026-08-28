// google-signin-error-feedback — GAPS the implementer's tests miss.
// Locks the failure→feedback mapping in hostedUiAuthorize that the existing suites
// don't pin: prompt type 'locked' → generic error; a success result whose params
// carry NO usable code → generic error (NOT a silent cancel); the documented
// !refreshToken success still seats an in-memory session; and a missing-config
// failure leaves status untouched (never authed). expo-auth-session + expo-secure-store
// mocked exactly like authGoogle.logic.test.ts.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'verifier';
    promptAsync = mockPromptAsync;
    constructor(_cfg: unknown) {}
  },
  exchangeCodeAsync: (...a: unknown[]) => mockExchange(...a),
  refreshAsync: jest.fn(),
}));

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => mockGetItem(...(a as [string, unknown])),
  setItemAsync: (...a: unknown[]) => mockSetItem(...(a as [string, string, unknown])),
  deleteItemAsync: (...a: unknown[]) => mockDeleteItem(...(a as [string])),
  canUseBiometricAuthentication: () => false,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const SENTINEL_KEY = 'abundo.cognito.hasSession';
const GENERIC = "Couldn't complete Google sign-in. Please try again.";
const NOT_CONFIGURED = "Sign-in isn't set up. Check the app configuration.";
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

beforeEach(() => {
  jest.resetModules();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
});

describe('hostedUiAuthorize failure-mapping gaps', () => {
  // [A7] a 'locked' prompt result is a real failure, not a silent cancel → generic error.
  it("prompt type 'locked' surfaces the generic failure (not silent)", async () => {
    mockPromptAsync.mockResolvedValue({ type: 'locked' });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false, error: GENERIC });
    expect(auth.getStatus()).not.toBe('authed');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  // [A8] success result but params.code is empty string → generic error, NOT silent.
  it("a 'success' with an empty params.code is a failure, not a silent cancel", async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: '' } });
    const auth = loadAuth();
    const res = await auth.signInWithGoogle();
    expect(res).toEqual({ ok: false, error: GENERIC });
    // Guard the exact regression: it must carry an error (the old code returned a bare
    // false here, which the new screen would treat as a silent cancel).
    expect((res as { error?: string }).error).toBe(GENERIC);
    expect(mockExchange).not.toHaveBeenCalled();
  });

  // [A9] success result with params present but no code key at all → generic error.
  it("a 'success' with params but no code key is a failure, not silent", async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { state: 'xyz' } });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false, error: GENERIC });
    expect(mockExchange).not.toHaveBeenCalled();
  });

  // [A10] DOCUMENTED behaviour: a token with NO refreshToken still resolves ok:true and
  // seats an in-memory authed session — but persists nothing, so it won't survive a
  // reload. Locking this so any future change to it is deliberate.
  it('a success WITHOUT a refresh token still seats an authed session but persists nothing', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'CODE' } });
    mockExchange.mockResolvedValue({ idToken: 'IDTOK', accessToken: 'AC', refreshToken: undefined, issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: true });
    expect(auth.getStatus()).toBe('authed');
    await expect(auth.getAuthToken()).resolves.toBe('IDTOK');
    // Nothing durable was written: no refresh token and no "session ready" sentinel.
    expect(mockSetItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(false);
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
  });

  // [A11] a missing-config failure must NOT seat a session or flip status to authed.
  it('missing config leaves status un-authed (no session leaked on the error path)', async () => {
    delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
    const auth = loadAuth();
    const before = auth.getStatus();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false, error: NOT_CONFIGURED });
    expect(auth.getStatus()).toBe(before);
    expect(auth.getStatus()).not.toBe('authed');
    expect(mockSetItem).not.toHaveBeenCalled();
  });
});
