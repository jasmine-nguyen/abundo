// WHIT-267 — adversarial GAP tests for the unlock-time guarded re-store in
// src/auth.ts (performUnlock). Complements the "unlock re-stores the token GUARDED"
// describe in authUnlockEdges.logic.test.ts (launch happy path, failed re-store,
// cancel/null unchanged, rotation last-write). Covers what THAT suite leaves open:
//   [A7]  the re-store fires on RESUME unlocks (lock() → unlock()) too, not just launch
//   [A8]  double unlock is single-flight: exactly ONE re-store write, ONE read
//   [A9]  rotating refresh + a FAILED re-store: the rotation write resurrects the
//         token (guarded) and the unlock still lands authed
//   [A10] hourly refresh after a FAILED re-store: in-memory token reused, keychain
//         never re-read (no surprise Face ID an hour later)
//   [A11] canBiometricLock() false at unlock time → NO re-store write (the guard that
//         stops an unguarded UPDATE of a guarded item, which would prompt on iOS)
//   [A12] Platform.OS 'android' → NO re-store write (the guarded WRITE itself prompts
//         on Android — the deliberate iOS-only exclusion)
// Same mock harness as authUnlockEdges.logic.test.ts, but react-native's Platform.OS
// is mutable per-test so the isIOS() gate can be exercised from both sides.
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

// Mutable platform: auth.ts reads require('react-native').Platform.OS at CALL time
// (isIOS), so a getter lets each test pick the platform without re-mocking.
let mockPlatformOS: string = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const SENTINEL_KEY = 'abundo.cognito.hasSession';
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

// The WHIT-267 shape: sentinel present, token stored while the flag was off. iOS reads
// the unguarded item through silently even with guarded opts, so the mock returning the
// token regardless of read opts IS the device behaviour.
const seedFlagFlipSession = () => {
  process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
  mockCanUseBiometric.mockReturnValue(true);
  mockGetItem.mockImplementation(async (k) => {
    if (k === SENTINEL_KEY) return '1';
    if (k === REFRESH_KEY) return 'R';
    return null;
  });
};

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

describe('WHIT-267 re-store on the RESUME path', () => {
  // [A7] The re-store is per-UNLOCK, not per-launch: a resume (lock() → unlock(), the
  // AuthGate background→active path) re-stores again. Fail-on-revert: with the WHIT-267
  // block gone, a NON-rotating refresh means zero guarded REFRESH_KEY writes ever.
  it('re-stores the token guarded on a resume unlock too — one read and one guarded write per unlock', async () => {
    seedFlagFlipSession();
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore(); // launch
    expect(auth.getStatus()).toBe('authed');
    expect(guardedRefreshWrites()).toHaveLength(1);
    expect(refreshReads()).toHaveLength(1);

    auth.lock(); // background→active drops the in-memory token (AuthGate.tsx resume path)
    expect(auth.getStatus()).toBe('locked');
    await expect(auth.unlock()).resolves.toBe(true); // resume unlock

    // One MORE read (= the one resume prompt) and one MORE guarded re-store — never
    // zero (re-store skipped on resume) and never more (no extra prompt/probe).
    expect(refreshReads()).toHaveLength(2);
    expect(guardedRefreshWrites()).toHaveLength(2);
    expect(guardedRefreshWrites()[1][1]).toBe('R');
    expect(auth.getStatus()).toBe('authed');
  });
});

describe('WHIT-267 re-store under the unlock single-flight', () => {
  // [A8] A double-tap / launch-overlapping-resume shares ONE performUnlock — so exactly
  // one guarded read AND exactly one re-store write. Fail-on-revert both ways: revert
  // the WHIT-267 block → 0 guarded writes; break the single-flight → 2 reads + 2 writes.
  it('two concurrent unlock() calls produce exactly one read and one guarded re-store', async () => {
    seedFlagFlipSession();
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    const [a, b] = await Promise.all([auth.unlock(), auth.unlock()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(refreshReads()).toHaveLength(1);
    expect(guardedRefreshWrites()).toHaveLength(1);
    expect(auth.getStatus()).toBe('authed');
  });
});

describe('WHIT-267 failed re-store combined with a ROTATING refresh', () => {
  // [A9] The nasty compound case: the re-store's delete succeeded but its create threw
  // (token momentarily gone from disk), and the refresh then ROTATES. The rotation's own
  // guarded write must resurrect the on-disk token (as R2) and the unlock must land
  // authed. Fail-on-revert: with the WHIT-267 block gone, the FIRST REFRESH_KEY write is
  // the rotation write itself — the mock makes that first write throw, refreshViaOAuth's
  // catch returns undefined, and the unlock dies at 'locked'.
  it('the rotation write resurrects the token guarded after a failed re-store; ends authed', async () => {
    seedFlagFlipSession();
    let failedOnce = false;
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY && !failedOnce) {
        failedOnce = true;
        throw new Error('create failed after delete');
      }
    });
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(auth.getStatus()).toBe('authed');
    // The failed attempt was the pre-rotation re-store of R…
    expect(refreshWrites()[0][1]).toBe('R');
    // …and the LAST (successful) write is the rotated token, guarded — the on-disk
    // token is resurrected, not left deleted for the next launch's null-read.
    const last = refreshWrites().at(-1)!;
    expect(last[1]).toBe('R2');
    expect(last[2]).toMatchObject({ requireAuthentication: true });
  });
});

describe('WHIT-267 failed re-store then the hourly refresh (getAuthToken)', () => {
  // [A10] Regression pin on the hourly-refresh interplay: after a FAILED re-store the
  // in-memory token (seeded AFTER the best-effort block) still feeds every later
  // refresh — the keychain is never re-read, so no surprise Face ID an hour in.
  // Fails-on-revert of the BEST-EFFORT CATCH (remove it → the throw hits the outer
  // catch → 'locked' → getAuthToken returns undefined), not of the whole block; the
  // no-re-store code passes this by construction (that's the pin, stated honestly).
  it('a later near-expiry refresh reuses the in-memory token with no extra keychain read', async () => {
    seedFlagFlipSession();
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    // Unlock's refresh hands back an ALREADY-EXPIRED id token (forces the next
    // getAuthToken to refresh again); the second refresh is fresh and non-rotating.
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', issuedAt: nowSec() - 4000, expiresIn: 3600 });
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();
    expect(auth.getStatus()).toBe('authed'); // best-effort: the failed re-store didn't derail unlock
    expect(refreshReads()).toHaveLength(1);

    await expect(auth.getAuthToken()).resolves.toBe('ID2');
    expect((mockRefresh.mock.calls[1][0] as { refreshToken: string }).refreshToken).toBe('R');
    expect(refreshReads()).toHaveLength(1); // STILL one — no re-read, no second prompt
  });
});

describe('WHIT-267 re-store gating', () => {
  // [A11] canBiometricLock() false at unlock time (flag off / device biometrics gone
  // mid-session) → the re-store must NOT run: secureOpts() would be {} and an unguarded
  // UPDATE of a still-guarded item is exactly the prompting/ambiguous iOS write the
  // scheme avoids. Fail-on-revert: drop `&& canBiometricLock()` and the write fires.
  it('skips the re-store when canBiometricLock() is false at unlock time — zero token writes', async () => {
    // Flag deliberately NOT set; device capable. A direct unlock() with a stored token.
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.unlock()).resolves.toBe(true);

    expect(auth.getStatus()).toBe('authed');
    expect(refreshWrites()).toHaveLength(0); // non-rotating refresh → the only candidate write was the re-store
    expect(refreshReads()[0][1]).toEqual({}); // and the read was unguarded (flag off)
  });

  // [A12] The deliberate ANDROID exclusion: a guarded WRITE on Android opens its own
  // biometric prompt (AESEncryptor), so the re-store would double-prompt every unlock.
  // Fail-on-revert: drop `isIOS() &&` and the guarded write fires on android.
  it('skips the re-store on Android — unlock still works, zero token writes', async () => {
    mockPlatformOS = 'android';
    seedFlagFlipSession();
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(auth.getStatus()).toBe('authed'); // the exclusion never breaks the unlock itself
    expect(refreshReads()).toHaveLength(1);
    expect(refreshWrites()).toHaveLength(0); // no guarded re-store on android
  });
});

// WHIT-270 — the flag-flip kill switch. After a WHIT-267 unlock the token is stored
// GUARDED; if the Face ID flag is later turned OFF, the signed-out restore reads that
// guarded item with an unguarded query and iOS still pops Face ID (the item's own ACL).
// The read can be CANCELLED (must not hang the gate) or SUCCEED (must not keep prompting
// on every future launch). Flag OFF here means EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED unset
// and mockCanUseBiometric false (both from beforeEach) → canBiometricLock() false →
// unlockOrRestore takes restoreSession, and getRefreshToken reads with `{}` opts.
describe('WHIT-270 — flag-off restore never hangs on a cancelled prompt', () => {
  // The prompt is CANCELLED → the guarded read rejects. restoreSession must RESOLVE to a
  // clean 'anon' (login screen), never reject/hang on 'loading' (the blank screen). The
  // stale guarded item is cleared so the next sign-in writes a fresh token.
  // Fail-on-revert: remove the try/catch around the read and the rejection propagates →
  // restoreSession() REJECTS → the `.resolves` assertion fails.
  it('a cancelled restore prompt resolves to anon and clears the stale item', async () => {
    mockGetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('user cancelled Face ID');
      return null;
    });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('anon');
    expect(deletesOf(REFRESH_KEY).length).toBeGreaterThan(0);
    expect(deletesOf(SENTINEL_KEY).length).toBeGreaterThan(0);
  });

  // getAuthToken (the hourly-refresh entry) shares the same choke point, so it must
  // recover the same way rather than surface an unhandled rejection.
  it('getAuthToken also recovers to anon on a cancelled read', async () => {
    mockGetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('user cancelled Face ID');
      return null;
    });
    const auth = loadAuth();

    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    expect(auth.getStatus()).toBe('anon');
  });
});

describe('WHIT-270 — flag-off restore re-stores the token unguarded (no repeat prompt)', () => {
  // The prompt SUCCEEDS → the read returns the token. Flag is OFF, so the token is
  // re-stored UNGUARDED via delete-then-create, so later launches read it silently.
  // Fail-on-revert: remove the resaveUnguarded call → no delete and no unguarded write.
  it('re-stores unguarded (delete-then-create) after a successful flag-off read', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    expect(refreshWrites()).toHaveLength(1); // non-rotating refresh → the re-store is the only write
    expect(unguardedRefreshWrites()).toHaveLength(1); // and it carries no requireAuthentication
    expect(deletesOf(REFRESH_KEY).length).toBeGreaterThan(0); // silent replace, not an in-place update
  });

  // End-to-end recurrence pin against a stateful keychain that starts GUARDED. After the
  // first flag-off launch the on-disk item must end UNGUARDED, so a second launch reads it
  // silently. Fail-on-revert: without the re-store the item stays guarded.
  it('leaves the on-disk token unguarded so a second launch does not re-prompt', async () => {
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
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(stored).toBe('R');
    expect(guarded).toBe(false);
  });
});

describe('WHIT-270 — re-store safety gate', () => {
  // The guard must NEVER strip protection while the biometric flag is ON (that would
  // silently disable Face ID). Exercise the keychain read directly via getAuthToken with
  // the flag on. Fail-on-revert: drop `|| canBiometricLock()` and the guard gets stripped.
  it('never re-stores unguarded while the biometric flag is ON', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.getAuthToken()).resolves.toBe('ID');
    expect(auth.getStatus()).toBe('authed');
    expect(deletesOf(REFRESH_KEY)).toHaveLength(0);
    expect(unguardedRefreshWrites()).toHaveLength(0);
  });

  // Android exclusion: the re-store is deliberately iOS-only (a guarded write prompts on
  // Android; the delete-then-create is skipped entirely). Restore still succeeds.
  // Fail-on-revert: drop `!isIOS() ||` and the delete+write fire on android.
  it('skips the re-store on Android — restore still succeeds', async () => {
    mockPlatformOS = 'android';
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    expect(deletesOf(REFRESH_KEY)).toHaveLength(0);
    expect(refreshWrites()).toHaveLength(0);
  });
});
