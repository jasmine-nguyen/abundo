// WHIT-270 — adversarial GAP tests for the FLAG-OFF restore path in src/auth.ts
// (refreshFromStoredToken + resaveUnguarded). Complements the 6 implementer tests in
// authUnlockRestoreGaps.logic.test.ts (cancel→anon, getAuthToken→anon, success→unguarded
// re-store, recurrence pin, flag-ON safety, Android skip). Covers what THOSE leave open:
//   [G1] clearStoredSession itself REJECTS inside the recovery catch → the best-effort
//        `.catch(() => {})` must still land 'anon' (never a rejected/hung restore)
//   [G2] resaveUnguarded's delete succeeds but the CREATE throws → the best-effort inner
//        catch must swallow it and the restore still proceeds 'authed' (never a hang)
//   [G3] a ROTATING refresh AFTER resaveUnguarded → the rotation write is unguarded too
//        (no double-guard), ends authed, the on-disk token is the rotated one
//   [G4] a NULL read (no token) on the flag-off path → 'anon' via the existing
//        `if (!refreshToken)` branch, and resaveUnguarded is NOT called (no stray
//        delete/write) — a regression pin that the new re-store didn't break it
// NOT duplicated here (already pinned elsewhere):
//   - the unlock CANCEL path staying 'locked' → authUnlockEdges.logic.test.ts:436
//     ('a CANCELLED prompt is unchanged: stays locked') proves the catch is NOT inside
//     getRefreshToken.
//   - the locked short-circuit (getAuthToken returns undefined, no keychain read while
//     'locked') → authUnlock.logic.test.ts:250 already pins auth.ts's locked guard.
// Same mock harness shape as authUnlockRestoreGaps.logic.test.ts.
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

let mockPlatformOS: string = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const SENTINEL_KEY = 'whittle.cognito.hasSession';
const DOMAIN = 'https://whittle-auth.auth.ap-southeast-2.amazoncognito.com';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

function refreshWrites() {
  return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function guardedRefreshWrites() {
  return refreshWrites().filter(
    (c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication,
  );
}
function unguardedRefreshWrites() {
  return refreshWrites().filter(
    (c) => !(c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication,
  );
}
function deletesOf(key: string) {
  return mockDeleteItem.mock.calls.filter((c) => c[0] === key);
}

beforeEach(() => {
  jest.resetModules();
  mockPlatformOS = 'ios';
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

// [G1] The recovery branch does `await clearStoredSession().catch(() => {})`. If the
// keychain WIPE itself rejects (a delete throws while clearing the stale item), the
// best-effort `.catch` must still swallow it so restore lands a clean 'anon' — the
// blank-screen hang is exactly what WHIT-270 fixes. Fail-on-revert: strip the
// `.catch(() => {})` and the clearStoredSession rejection escapes → restoreSession REJECTS.
describe('WHIT-270 — recovery survives clearStoredSession itself rejecting', () => {
  it('a cancelled read AND a failing keychain wipe still resolves to anon', async () => {
    mockGetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('user cancelled Face ID');
      return null;
    });
    // Every delete rejects → clearStoredSession() rejects on its first deleteItemAsync.
    mockDeleteItem.mockRejectedValue(new Error('keychain delete denied'));
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('anon');
  });
});

// [G2] resaveUnguarded is delete-then-create. The scary partial failure: the delete
// SUCCEEDS (token now gone from disk) but the create THROWS. The inner best-effort catch
// must swallow it so THIS launch still finishes 'authed' from the in-memory token — never
// a hang. Fail-on-revert: remove resaveUnguarded's try/catch and the setItem throw escapes
// out of refreshFromStoredToken (the `await resaveUnguarded(...)` is unguarded) → restore
// REJECTS instead of resolving true.
describe('WHIT-270 — resaveUnguarded create failure is best-effort', () => {
  it('delete succeeds but the unguarded create throws → restore still ends authed', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // Non-rotating refresh, so the ONLY REFRESH write is the resave create — make it throw.
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain create denied');
    });
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    // The delete DID fire (token momentarily removed) — the failure was on the re-create.
    expect(deletesOf(REFRESH_KEY).length).toBeGreaterThan(0);
  });
});

// [G3] Interaction pin: flag-off read succeeds → resaveUnguarded writes the token
// UNGUARDED, then the OAuth refresh ROTATES (returns R2) → setRefreshToken(R2) also runs.
// With the flag OFF secureOpts() is {}, so BOTH writes are unguarded (no double-guard, and
// no re-prompt), the rotated token wins on disk, and the restore ends authed. Uses a
// stateful keychain to assert the end state. Fail-on-revert: comment resaveUnguarded's body
// → only the single rotation write remains (1 write, 0 resave delete) → the write-count and
// delete-count assertions fail.
describe('WHIT-270 — rotating refresh after the unguarded re-store', () => {
  it('the rotation write stays unguarded and wins on disk; ends authed', async () => {
    let stored: string | null = 'R';
    let guarded = true;
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? stored : null));
    mockDeleteItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) {
        stored = null;
        guarded = false;
      }
    });
    mockSetItem.mockImplementation(async (k, v, opts) => {
      if (k === REFRESH_KEY) {
        stored = v;
        guarded = !!(opts as { requireAuthentication?: boolean } | undefined)?.requireAuthentication;
      }
    });
    // Rotating refresh: hands back a NEW refresh token R2.
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    // Two writes: the unguarded re-store of R, then the unguarded rotation write of R2.
    expect(unguardedRefreshWrites()).toHaveLength(2);
    expect(guardedRefreshWrites()).toHaveLength(0); // never re-guarded on the flag-off path
    expect(deletesOf(REFRESH_KEY)).toHaveLength(1); // only the resave deletes; the unguarded rotation write does not
    // End state: the rotated token, still unguarded so a later launch reads it silently.
    expect(stored).toBe('R2');
    expect(guarded).toBe(false);
  });
});

// [G4] Regression pin: on the flag-off path with NO stored token (null read), the existing
// `if (!refreshToken)` branch must still drop cleanly to 'anon' — and resaveUnguarded must
// NOT run (it is guarded by `if (refreshToken)`). If that guard were dropped,
// resaveUnguarded(null) would delete then write a null token. Assert zero token deletes AND
// zero token writes to prove the new re-store never touches the empty-keychain path.
describe('WHIT-270 — null read on the flag-off path is unchanged', () => {
  it('no stored token → anon, and resaveUnguarded never fires (no stray delete/write)', async () => {
    // Default mockGetItem resolves null for every key (flag off from beforeEach).
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('anon');
    expect(refreshWrites()).toHaveLength(0);
    expect(deletesOf(REFRESH_KEY)).toHaveLength(0);
  });
});
