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

// WHIT-267: auth.ts gates the unlock-time guarded re-store on Platform.OS === 'ios'
// (via a tolerant lazy require — see isIOS). This node-env suite must mock react-native
// to exercise that branch; suites that don't mock it simply skip the re-store.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const SENTINEL_KEY = 'abundo.cognito.hasSession';
const METHOD_KEY = 'abundo.cognito.authMethod';
const DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
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

// --- WHIT-172: retroactively biometric-lock a pre-WHIT-161 session --------------
describe('unlockOrRestore migrates a pre-WHIT-161 session (WHIT-172)', () => {
  it('upgrades an unguarded token with no sentinel: UNGUARDED detection read, GUARDED re-store, sentinel written, then unlock', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    // Pre-WHIT-161 state: a refresh token exists but NO sentinel.
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // The post-migration unlock refresh succeeds and is NON-rotating (no refreshToken
    // back), so the ONLY guarded REFRESH_KEY write is the migration re-store — a rotated
    // token would otherwise let restore write REFRESH_KEY guarded on the revert path too.
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // (a) the detection read was UNGUARDED ({} opts) — this is what sidesteps the iOS
    //     guarded-read-of-unguarded-item ambiguity the card was deferred on.
    expect(refreshReads()[0][1]).toEqual({});
    // (b) the token was re-stored GUARDED (requireAuthentication), preceded by a delete
    //     (the WHIT-170 silent create path).
    const guardedWrite = refreshWrites().find(
      (c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication,
    );
    expect(guardedWrite).toBeTruthy();
    expect(guardedWrite![1]).toBe('R');
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(true);
    // (c) the sentinel was written — restoreSession NEVER writes it, so this binds
    //     fail-on-revert (the old unlockOrRestore falls straight to restore).
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(true);
    // (d) ended authed via the unlock path. (Passes on revert too — NOT a binding assert.)
    expect(auth.getStatus()).toBe('authed');
  });

  it('rolls back cleanly when the guarded re-store FAILS mid-migration: no orphan sentinel, session cleared, not authed', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // The guarded re-store write throws (a keychain hiccup); the sentinel write, if
    // reached, would succeed.
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // No orphan sentinel: it is written only AFTER a successful token re-store.
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    // Rollback cleared the stored session — clearStoredSession deletes the method key,
    // which nothing else on this path touches, so it binds the rollback ran.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === METHOD_KEY)).toBe(true);
    // Fell through to restore → 'anon' (a clean re-login), never a half-migrated authed.
    expect(auth.getStatus()).toBe('anon');
  });

  it('does NOT migrate when biometrics are OFF: no sentinel write, no guarded re-store (migration is gated on canBiometricLock)', async () => {
    // Flag OFF (unset by beforeEach); the device is capable but the feature is off.
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    expect(
      refreshWrites().some((c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication),
    ).toBe(false);
    expect(auth.getStatus()).toBe('authed'); // plain WHIT-160 unguarded restore still works
  });

  it('does NOT migrate a WHIT-161 session (sentinel present): straight to unlock, first refresh-key read is GUARDED not the {} detection read', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    // Sentinel present + guarded token = a WHIT-161 session; migration must be skipped.
    mockGetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) return '1';
      if (k === REFRESH_KEY) return 'R';
      return null;
    });
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // The FIRST refresh-key read is unlock()'s GUARDED read, never an unguarded ({})
    // migration detection read — proving migration was not entered ahead of unlock.
    expect(refreshReads()[0][1]).toMatchObject({ requireAuthentication: true });
    expect(auth.getStatus()).toBe('authed');
  });
});

// --- WHIT-172 (qa): adversarial migration gaps the implementer's tests leave open --
// Complements the implementer's happy-path / re-store-throws / biometrics-off / sentinel-
// present cases. Each either fails on a full revert of the migration code, or is an
// explicitly-labelled regression guard anchored fail-on-revert by a sentinel-write assert.
describe('unlockOrRestore migration — adversarial gaps (WHIT-172 qa)', () => {
  it('fresh install (detection read null, no sentinel): the {} detection read is a pure no-op — no sentinel write, no guarded re-store, no rollback deletes → restore → anon', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockResolvedValue(null); // genuinely empty store — a first-ever launch
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // Fail-on-revert: the FIRST refresh-key read is the UNGUARDED ({}) detection read.
    // The reverted code has no migration, so its first refresh-key read is restore's
    // GUARDED read (requireAuthentication), and this .toEqual({}) fails.
    expect(refreshReads()[0][1]).toEqual({});
    // A null detection must NOT fabricate a session: no sentinel, no guarded re-store...
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    expect(
      refreshWrites().some((c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication),
    ).toBe(false);
    // ...and the `!refreshToken → return false` branch returns BEFORE the catch, so the
    // rollback (clearStoredSession) never runs — a null detection touches zero keys.
    expect(mockDeleteItem).not.toHaveBeenCalled();
    expect(auth.getStatus()).toBe('anon');
  });

  it('migration succeeds but the post-migration unlock refresh FAILS offline → stays LOCKED with the session preserved, never anon', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockRejectedValue(new Error('offline')); // /oauth2/token unreachable
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // Migration ran (sentinel written) — the fail-on-revert anchor: the reverted code has
    // no migration, so no-sentinel + offline flows restoreSession → clearSession → 'anon'.
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(true);
    // unlock() OWNS the terminal status: a migrated-then-offline refresh keeps the session
    // LOCKED (retry / sign-in-again) instead of dropping it to anon (WHIT-171 contract).
    expect(mockRefresh).toHaveBeenCalled();
    expect(auth.getStatus()).toBe('locked');
  });

  it('migration does NOT write the auth-method key, preserving the null→OAuth default so a WHIT-160 session refreshes via /oauth2/token', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // Non-rotating OAuth refresh success. refreshAsync (OAuth) being invoked — not the SRP
    // InitiateAuth `fetch` — is what proves the route stayed OAuth after migration.
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // Migration ran — fail-on-revert anchor (revert never writes the sentinel).
    expect(mockSetItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(true);
    // GUARD: a WHIT-160 session is OAuth; migration must not stamp AUTH_METHOD_KEY. Writing
    // 'srp' here would mis-route every hourly refresh to InitiateAuth. (Holds on revert too
    // — the regression guard, anchored fail-on-revert by the sentinel assertion above.)
    expect(mockSetItem.mock.calls.some((c) => c[0] === METHOD_KEY)).toBe(false);
    expect(mockRefresh).toHaveBeenCalled();
    expect(auth.getStatus()).toBe('authed');
  });

  it('SECURITY: sentinel write throws AFTER a successful guarded re-store → the WRITTEN guarded token is rolled back, no guarded-token-without-sentinel orphan survives', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // Unlike the implementer's re-store-THROWS case (no guarded token ever written), here
    // the guarded re-store SUCCEEDS and only the sentinel write throws — so a guarded token
    // really exists at the moment of failure and rollback must remove it.
    mockSetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) throw new Error('sentinel write denied');
    });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    // The guarded token WAS written (we got past the re-store)...
    const guardedWrite = refreshWrites().find(
      (c) => (c[2] as { requireAuthentication?: boolean } | undefined)?.requireAuthentication,
    );
    expect(guardedWrite).toBeTruthy();
    // ...then the migration catch ran clearStoredSession — bound by the METHOD_KEY delete,
    // which ONLY clearStoredSession performs on this path. Fail-on-revert: the reverted code
    // has no migration, so it never re-stores a token nor deletes the method key here.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === METHOD_KEY)).toBe(true);
    // The written guarded token and the (thrown) sentinel are both deleted → no orphan.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(true);
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(true);
    // Clean signed-out, never a half-migrated authed.
    expect(auth.getStatus()).not.toBe('authed');
  });
});

// --- WHIT-172: signIn partial-persist rollback (keeps the invariant airtight) ---
describe('signIn partial-persist rollback', () => {
  it('rolls back when the sentinel write fails AFTER the guarded token write, so no guarded-token-without-sentinel orphan survives', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
    mockExchange.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
    // The guarded token + method writes SUCCEED; only the sentinel write THROWS → a
    // partial persist that would otherwise strand a guarded token with no sentinel.
    mockSetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) throw new Error('sentinel write denied');
    });
    const auth = loadAuth();

    await expect(auth.signIn()).resolves.toBe(false);
    // The rollback deletes the auth-method key, which the normal persist path only ever
    // WRITES (never deletes) — so a method-key DELETE binds that clearStoredSession ran.
    // Fail-on-revert: without the rollback the outer catch just returns false and the
    // guarded token + method key survive → this delete never fires.
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === METHOD_KEY)).toBe(true);
    expect(auth.getStatus()).not.toBe('authed');
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
    // (WHIT-267 rebind: the re-store's delete-then-create DOES touch REFRESH_KEY now, so
    // "no delete ever" is no longer the wipe signal. The wipe signals are: the sentinel
    // being deleted, or a delete NOT followed by a re-write of the same token.)
    expect(mockDeleteItem.mock.calls.some((c) => c[0] === SENTINEL_KEY)).toBe(false);
    expect(refreshWrites().some((c) => c[1] === 'R')).toBe(true); // net token state preserved
  });
});

// --- WHIT-267: unlock-time guarded re-store (the flag-flip migration) ------------
describe('unlock re-stores the token GUARDED (WHIT-267)', () => {
  // The bug: a session seated while the flag was OFF is stored unguarded, and iOS reads
  // it through silently even with guarded opts — so the mock below returning the token
  // regardless of read opts IS the device behaviour, not a shortcut.
  const seedFlagFlipSession = () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) return '1';
      if (k === REFRESH_KEY) return 'R';
      return null;
    });
  };

  it('fail-on-revert: the silently-read token is re-stored GUARDED via the silent delete-then-create path, one read only', async () => {
    seedFlagFlipSession();
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
    seedFlagFlipSession();
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

  it('a CANCELLED prompt is unchanged: stays locked, zero token writes (no re-store attempted)', async () => {
    seedFlagFlipSession();
    mockGetItem.mockImplementation(async (k) => {
      if (k === SENTINEL_KEY) return '1';
      if (k === REFRESH_KEY) throw new Error('user cancelled');
      return null;
    });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(auth.getStatus()).toBe('locked');
    expect(refreshWrites()).toHaveLength(0);
  });

  it('a NULL read (biometrics changed) is unchanged: clean re-login, zero token writes', async () => {
    seedFlagFlipSession();
    mockGetItem.mockImplementation(async (k) => (k === SENTINEL_KEY ? '1' : null));
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(auth.getStatus()).toBe('anon');
    expect(refreshWrites()).toHaveLength(0);
  });
});
