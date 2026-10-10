// WHIT-161 — adversarial GAP tests for the Face ID / biometric-lock logic in
// src/auth.ts. Complements authUnlock.logic.test.ts (happy path + acceptance).
// Covers the edges the implementer left open:
//   - guarded WRITE failure on a biometric device → clean signed-out, no orphan sentinel
//   - refresh-token ROTATION while authed → rotated token re-written GUARDED + in-memory
//     copy updated (no stale token, no second prompt)
//   - unlockOrRestore with biometrics active but NO stored session → restore, never 'locked'
// Same mock harness as authUnlock.logic.test.ts so nothing native/networked loads.
// Also holds the WHIT-267 / WHIT-270 / WHIT-274 Face ID bug repros (folded in by WHIT-459).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REFRESH_KEY, SENTINEL_KEY, METHOD_KEY, loadAuth, nowSec } from './support/authModule';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () =>
  require('./support/authModule').authSessionMock({ promptAsync: mockPromptAsync, exchange: mockExchange, refresh: mockRefresh }),
);

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
const mockCanUseBiometric = jest.fn<() => boolean>(() => false);
jest.mock('expo-secure-store', () =>
  require('./support/authModule').secureStoreMock({ getItem: mockGetItem, setItem: mockSetItem, deleteItem: mockDeleteItem, canUseBiometric: mockCanUseBiometric }),
);

// WHIT-267: auth.ts gates the unlock-time guarded re-store on Platform.OS === 'ios'
// (via a tolerant lazy require — see isIOS). This node-env suite must mock react-native
// to exercise that branch; suites that don't mock it simply skip the re-store.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';

function refreshReads() {
  return mockGetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function refreshWrites() {
  return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
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
});

// --- guarded WRITE path on a biometric device -----------------------------------
describe('signInWithGoogle guarded-write path', () => {
  it('a keychain write FAILURE leaves a clean signed-out state: returns false, NO orphan sentinel, not authed', async () => {
    mockCanUseBiometric.mockReturnValue(true);
    // The guarded refresh-token write fails; the sentinel write (if reached) would succeed.
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.signInWithGoogle()).resolves.toEqual({
      ok: false,
      error: "Couldn't complete Google sign-in. Please try again.",
    });
    // Token written FIRST, sentinel AFTER: a failed token write must never leave a
    // "session exists" marker pointing at a token that isn't there.
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    expect(auth.getStatus()).not.toBe('authed');
  });
});

// --- refresh-token ROTATION while authed ----------------------------------------
describe('refresh-token rotation', () => {
  it('re-writes the rotated token GUARDED and updates the in-memory copy (next refresh reuses it, no re-prompt)', async () => {
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
    // WHIT-267 ordering pin: the unlock-time re-store of the PRE-rotation token runs
    // BEFORE refreshTokens, so the rotated token is always the LAST write — moving the
    // re-store after the refresh would persist the stale token and break next launch.
    expect(refreshWrites().at(-1)![1]).toBe('R2');

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

// --- WHIT-172: signInWithGoogle partial-persist rollback (keeps the invariant airtight) ---
describe('signInWithGoogle partial-persist rollback', () => {
  it('rolls back when the sentinel write fails AFTER the guarded token write, so no guarded-token-without-sentinel orphan survives', async () => {
    mockCanUseBiometric.mockReturnValue(true);
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    // The guarded token + method writes SUCCEED; only the sentinel write THROWS → a
    // partial persist that would otherwise strand a guarded token with no sentinel.
    mockSetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) throw new Error('sentinel write denied');
    });
    const auth = loadAuth();

    await expect(auth.signInWithGoogle()).resolves.toEqual({
      ok: false,
      error: "Couldn't complete Google sign-in. Please try again.",
    });
    // The rollback deletes the auth-method key, which the normal persist path only ever
    // WRITES (never deletes) — so a method-key DELETE binds that clearStoredSession ran.
    // Fail-on-revert: without the rollback the outer catch just returns the error result
    // and the guarded token + method key survive → this delete never fires.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === METHOD_KEY)).toBe(true);
    expect(auth.getStatus()).not.toBe('authed');
  });
});

// --- WHIT-267: unlock-time guarded re-store (the biometrics-unavailable migration) ------------
describe('unlock re-stores the token GUARDED (WHIT-267)', () => {
  // The bug: a session seated while biometrics were unavailable is stored unguarded, and iOS reads
  // it through silently even with guarded opts — so the mock below returning the token
  // regardless of read opts IS the device behaviour, not a shortcut.
  const seedUnguardedSession = () => {
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) return '1';
      if (k === REFRESH_KEY) return 'R';
      return null;
    });
  };

  it('fail-on-revert: the silently-read token is re-stored GUARDED via the silent delete-then-create path, one read only', async () => {
    seedUnguardedSession();
    // NON-rotating refresh, so the ONLY possible guarded REFRESH_KEY write is the
    // WHIT-267 re-store — on revert, no guarded write happens at all and this fails.
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    const guardedWrite = refreshWrites().find(
      (c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication,
    );
    expect(guardedWrite).toBeTruthy();
    expect(guardedWrite![1]).toBe('R');
    // WHIT-170 silent CREATE path: the guarded write is preceded by the delete.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(true);
    // One-prompt invariant: exactly ONE keychain read of the refresh token — the
    // re-store must never add a probe read (a probe of a guarded item would prompt).
    expect(refreshReads()).toHaveLength(1);
    expect(auth.getStatus()).toBe('authed');
  });

  it('a FAILED re-store is best-effort: unlock still completes from the in-memory token, sentinel untouched, never mistaken for a cancel', async () => {
    seedUnguardedSession();
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // The refresh ran with the in-memory token (unlock proceeded past the failure)…
    expect((mockRefresh.mock.calls[0][0] as { refreshToken: string }).refreshToken).toBe('R');
    // …ending authed (a write failure is NOT the outer catch's "cancelled → locked").
    expect(auth.getStatus()).toBe('authed');
    // The sentinel is never deleted by the best-effort path (no rollback, no wipe).
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------
// WHIT-267 (folded from authUnlockRestoreGaps.logic.test.ts)
// Adversarial GAP tests for the unlock-time guarded re-store in src/auth.ts (performUnlock).
// Covers: canBiometricLock() false at unlock time → no re-store; the biometrics-unavailable
// restore (cancelled prompt → anon; success → unguarded re-store; never strips the guard
// while biometrics are available).
// -------------------------------------------------------------------------------------
describe('WHIT-267 (folded from authUnlockRestoreGaps.logic.test.ts)', () => {
  describe('WHIT-267 re-store gating', () => {
    // [A11] canBiometricLock() false at unlock time (device biometrics gone mid-session)
    // → the re-store must NOT run: secureOpts() would be {} and an unguarded
    // UPDATE of a still-guarded item is exactly the prompting/ambiguous iOS write the
    // scheme avoids. Fail-on-revert: drop `&& canBiometricLock()` and the write fires.
    it('skips the re-store when canBiometricLock() is false at unlock time — zero token writes', async () => {
      // Device biometrics unavailable. A direct unlock() with a stored token.
      mockCanUseBiometric.mockReturnValue(false);
      mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
      mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
      const auth = loadAuth();

      await expect(auth.unlock()).resolves.toBe(true);

      expect(auth.getStatus()).toBe('authed');
      expect(refreshWrites()).toHaveLength(0); // non-rotating refresh → the only candidate write was the re-store
      expect(refreshReads()[0][1]).toEqual({}); // and the read was unguarded (biometrics unavailable)
    });
  });

  // WHIT-270 — biometrics going away. After a WHIT-267 unlock the token is stored
  // GUARDED; if the device's biometrics later become unavailable, the signed-out restore reads
  // that guarded item with an unguarded query and iOS still pops Face ID (the item's own ACL).
  // The read can be CANCELLED (must not hang the gate) or SUCCEED (must not keep prompting
  // on every future launch). Biometrics unavailable here means mockCanUseBiometric false
  // (from beforeEach) → canBiometricLock() false → unlockOrRestore takes restoreSession,
  // and getRefreshToken reads with `{}` opts.
  describe('WHIT-270 — biometrics-unavailable restore never hangs on a cancelled prompt', () => {
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
  });

  describe('WHIT-270 — biometrics-unavailable restore re-stores the token unguarded (no repeat prompt)', () => {
    // The prompt SUCCEEDS → the read returns the token. Biometrics are unavailable, so the token is
    // re-stored UNGUARDED via delete-then-create, so later launches read it silently.
    // Fail-on-revert: remove the resaveUnguarded call → no delete and no unguarded write.
    it('re-stores unguarded (delete-then-create) after a successful biometrics-unavailable read', async () => {
      mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
      mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
      const auth = loadAuth();

      await expect(auth.restoreSession()).resolves.toBe(true);
      expect(auth.getStatus()).toBe('authed');
      expect(refreshWrites()).toHaveLength(1); // non-rotating refresh → the re-store is the only write
      expect(unguardedRefreshWrites()).toHaveLength(1); // and it carries no requireAuthentication
      expect(deletesOf(REFRESH_KEY).length).toBeGreaterThan(0); // silent replace, not an in-place update
    });
  });

  describe('WHIT-270 — re-store safety gate', () => {
    // The guard must NEVER strip protection while biometrics are available (that would
    // silently disable Face ID). Exercise the keychain read directly via getAuthToken on
    // a capable device. Fail-on-revert: drop `|| canBiometricLock()` and the guard gets stripped.
    it('never re-stores unguarded while biometrics are available', async () => {
      mockCanUseBiometric.mockReturnValue(true);
      mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
      mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
      const auth = loadAuth();

      await expect(auth.getAuthToken()).resolves.toBe('ID');
      expect(auth.getStatus()).toBe('authed');
      expect(deletesOf(REFRESH_KEY)).toHaveLength(0);
      expect(unguardedRefreshWrites()).toHaveLength(0);
    });
  });
});

// -------------------------------------------------------------------------------------
// WHIT-270 (folded from authRestoreResaveGaps.logic.test.ts)
// The biometrics-unavailable restore seed (WHIT-274).
// -------------------------------------------------------------------------------------
describe('WHIT-270 (folded from authRestoreResaveGaps.logic.test.ts)', () => {
  // [G5] WHIT-274 — the seed pin. On the biometrics-unavailable NON-ROTATING path the first restore reads
  // the keychain once and re-saves the token unguarded. The fix seeds session.refreshToken so
  // the NEXT hourly refresh reuses memory — no second keychain read, no second resave. Without
  // the seed, cacheToken leaves session.refreshToken undefined (a refresh omits it and there's
  // nothing to fall back to), so every hourly refresh re-enters the keychain-read branch and
  // re-runs resaveUnguarded (delete + create) forever. Fail-on-revert: drop the `session = {…}`
  // seed → the second getAuthToken re-reads the keychain → reads==2 and a second delete/write,
  // and each count assertion below fails.
  describe('WHIT-274 — biometrics-unavailable non-rotating restore seeds memory for the hourly refresh', () => {
    it('a second refresh reuses the in-memory token: no extra keychain read or resave', async () => {
      mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
      // Non-rotating: neither response carries a refreshToken. The first id token is already
      // near-expiry so the second getAuthToken forces a real refresh instead of serving cache.
      mockRefresh
        .mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', issuedAt: nowSec() - 4000, expiresIn: 3600 })
        .mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
      const auth = loadAuth();

      await expect(auth.restoreSession()).resolves.toBe(true);
      expect(auth.getStatus()).toBe('authed');

      // The hourly refresh: the near-expiry first token forces a genuine second swap.
      await expect(auth.getAuthToken()).resolves.toBe('ID2');

      // The seed made the second refresh reuse memory — the keychain was touched only once.
      expect(refreshReads()).toHaveLength(1);
      expect(deletesOf(REFRESH_KEY)).toHaveLength(1); // only the first restore's resave delete
      expect(refreshWrites()).toHaveLength(1); //         only the first restore's resave create
      // And the second refresh reused the same token 'R', not a fresh keychain read.
      expect((mockRefresh.mock.calls[1][0] as { refreshToken: string }).refreshToken).toBe('R');
    });
  });
});
