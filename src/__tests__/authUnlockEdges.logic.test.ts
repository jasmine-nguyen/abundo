// WHIT-161 — adversarial GAP tests for the Face ID / biometric-lock logic in
// src/auth.ts. Complements authUnlock.logic.test.ts (happy path + acceptance).
// Covers the edges the implementer left open:
//   - guarded WRITE failure on a biometric device → clean signed-out, no orphan sentinel
//   - refresh-token ROTATION while authed → rotated token re-written GUARDED + in-memory
//     copy updated (no stale token, no second prompt)
//   - unlockOrRestore with biometrics active but NO stored session → restore, never 'locked'
//   - unlock with missing config → graceful (stays locked, retains session, no throw)
// Same mock harness as authUnlock.logic.test.ts so nothing native/networked loads.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'verifier';
    promptAsync = mockPromptAsync;
  },
  exchangeCodeAsync: (...a: unknown[]) => mockExchange(...a),
  refreshAsync: (...a: unknown[]) => mockRefresh(...a),
}));

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
const mockCanUseBiometric = jest.fn<() => boolean>(() => false);
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => mockGetItem(...(a as [string, unknown])),
  setItemAsync: (...a: unknown[]) => mockSetItem(...(a as [string, string, unknown])),
  deleteItemAsync: (...a: unknown[]) => mockDeleteItem(...(a as [string])),
  canUseBiometricAuthentication: () => mockCanUseBiometric(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const SENTINEL_KEY = 'whittle.cognito.hasSession';
const DOMAIN = 'https://whittle-auth.auth.ap-southeast-2.amazoncognito.com';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

function refreshReads() {
  return mockGetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function refreshWrites() {
  return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}

beforeEach(() => {
  jest.resetModules();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockRefresh.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
  mockCanUseBiometric.mockReset().mockReturnValue(false);
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
});

// --- guarded WRITE path on a biometric device -----------------------------------
describe('signIn guarded-write path', () => {
  it('a keychain write FAILURE leaves a clean signed-out state: returns false, NO orphan sentinel, not authed', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    // The guarded refresh-token write fails; the sentinel write (if reached) would succeed.
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.signIn()).resolves.toBe(false);
    // Token written FIRST, sentinel AFTER: a failed token write must never leave a
    // "session exists" marker pointing at a token that isn't there.
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    expect(auth.getStatus()).not.toBe('authed');
  });
});

// --- refresh-token ROTATION while authed ----------------------------------------
describe('refresh-token rotation', () => {
  it('re-writes the rotated token GUARDED and updates the in-memory copy (next refresh reuses it, no re-prompt)', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // First refresh (during unlock) ROTATES the refresh token to 'R2' and hands back an
    // already-expired id token, forcing a second refresh; the second returns no rotation.
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', refreshToken: 'R2', issuedAt: nowSec() - 4000, expiresIn: 3600 });
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.unlock()).resolves.toBe(true);
    // The rotated token was persisted GUARDED (requireAuthentication), not left stale.
    const rotatedWrite = refreshWrites().find((c) => c[1] === 'R2');
    expect(rotatedWrite).toBeTruthy();
    expect(rotatedWrite![2]).toMatchObject({ requireAuthentication: true });

    // Next refresh must use the ROTATED token from memory — proves the in-memory copy
    // was updated — and must NOT re-read the guarded keychain (no second Face ID).
    await expect(auth.getAuthToken()).resolves.toBe('ID2');
    expect((mockRefresh.mock.calls[1][0] as { refreshToken: string }).refreshToken).toBe('R2');
    expect(refreshReads()).toHaveLength(1);
  });
});

// --- unlockOrRestore: biometrics active but no stored session -------------------
describe('unlockOrRestore with no stored session', () => {
  it('falls to RESTORE and never enters the locked state (no blind lock screen) when the sentinel is absent', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockResolvedValue(null); // no sentinel, no token
    const auth = loadAuth();

    const seen: string[] = [];
    auth.subscribe(() => seen.push(auth.getStatus()));
    await auth.unlockOrRestore();

    // unlock() would emit 'locked' first; the restore path never does. A regression that
    // routed to unlock() blindly would surface a 'locked' transition here.
    expect(seen).not.toContain('locked');
    expect(auth.getStatus()).toBe('anon');
  });
});

// --- unlock with missing config --------------------------------------------------
describe('unlock with missing OAuth config', () => {
  it('is graceful: reads the token, refresh no-ops on missing domain → stays LOCKED, keeps the stored session, never throws', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN; // config gone
    const auth = loadAuth();

    await expect(auth.unlock()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('locked');
    // The stored session must NOT be wiped on a config/transient failure — the user can
    // retry (or Sign in again); this is not the null-token "biometrics changed" path.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(false);
  });
});
