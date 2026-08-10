// WHIT-161 — adversarial GAP tests for the Face ID / biometric-lock logic in
// src/auth.ts. Complements authUnlock.logic.test.ts (happy path + acceptance).
// Covers the edges the implementer left open:
//   - guarded WRITE failure on a biometric device → clean signed-out, no orphan sentinel
//   - refresh-token ROTATION while authed → rotated token re-written GUARDED + in-memory
//     copy updated (no stale token, no second prompt)
//   - unlockOrRestore with biometrics active but NO stored session → restore, never 'locked'
//   - unlock with missing config → graceful (stays locked, retains session, no throw)
// Same mock harness as authUnlock.logic.test.ts so nothing native/networked loads.
//
// WHIT-459 — this file is the SURVIVOR of a 4-file test fold. Folded in below (each as
// its own outer describe, with its own beforeEach/afterEach) and git-rm'd:
//   - authUnlockRestoreGaps.logic.test.ts (WHIT-267, 12 its)
//   - authRestoreResaveGaps.logic.test.ts (WHIT-270, 5 its)
//   - authRestoreSeedGaps.logic.test.ts   (WHIT-274, 2 its) — re-homed here (its harness
//     matches THIS family, not authPasswordEdges/cognito).
// The module-scope harness below is the SUPERSET all four share.
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
// WHIT-459: upgraded from the survivor's hardcoded `{ Platform: { OS: 'ios' } }` to the
// mutable-getter form the folded gaps use — auth.ts reads require('react-native').Platform.OS
// at CALL time (isIOS), so a getter lets each test pick the platform without re-mocking.
// The survivor's own tests assume iOS, so every beforeEach re-seeds mockPlatformOS = 'ios'.
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
const METHOD_KEY = 'abundo.cognito.authMethod';
const DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
const POOL_ID = 'ap-southeast-2_pool123'; // WHIT-459: folded-in from authRestoreSeedGaps
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

// WHIT-459: declared at module scope but NOT wired to globalThis.fetch in the module
// beforeEach — only the re-homed authRestoreSeedGaps block sets globalThis.fetch/POOL_ID,
// so the survivor and the other folded gaps never see a mocked fetch.
let mockFetch: ReturnType<typeof jest.fn>;

function refreshReads() {
  return mockGetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function refreshWrites() {
  return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
// WHIT-459: unioned in from the folded gaps (byte-identical across authUnlockRestoreGaps +
// authRestoreResaveGaps); the survivor's own tests don't use them, the folded blocks do.
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

// --- guarded WRITE path on a biometric device -----------------------------------
describe('signInWithGoogle guarded-write path', () => {
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

    await expect(auth.signInWithGoogle()).resolves.toBe(false);
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

// --- WHIT-172: signInWithGoogle partial-persist rollback (keeps the invariant airtight) ---
describe('signInWithGoogle partial-persist rollback', () => {
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

    await expect(auth.signInWithGoogle()).resolves.toBe(false);
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

// =====================================================================================
// WHIT-459 FOLD — the three merged gaps files follow, each as its own outer describe with
// its OWN beforeEach/afterEach (referencing the shared module mock vars above). The module
// beforeEach runs FIRST (shared reset); each block's own beforeEach runs AFTER, layering its
// original setup on top — exactly as the originals ran standalone.
// =====================================================================================

// -------------------------------------------------------------------------------------
// WHIT-267 (folded from authUnlockRestoreGaps.logic.test.ts)
// Adversarial GAP tests for the unlock-time guarded re-store in src/auth.ts (performUnlock).
// Complements the "unlock re-stores the token GUARDED" describe above (launch happy path,
// failed re-store, cancel/null unchanged, rotation last-write). Covers what THAT leaves open:
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
// react-native's Platform.OS is mutable per-test (shared module getter) so the isIOS()
// gate can be exercised from both sides.
// -------------------------------------------------------------------------------------
describe('WHIT-267 (folded from authUnlockRestoreGaps.logic.test.ts)', () => {
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
});

// -------------------------------------------------------------------------------------
// WHIT-270 (folded from authRestoreResaveGaps.logic.test.ts)
// Adversarial GAP tests for the FLAG-OFF restore path in src/auth.ts (refreshFromStoredToken
// + resaveUnguarded). Complements the WHIT-267 folded block above (cancel→anon,
// getAuthToken→anon, success→unguarded re-store, recurrence pin, flag-ON safety, Android
// skip). Covers what THOSE leave open:
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
//   - the unlock CANCEL path staying 'locked' → the WHIT-267 describe above
//     ('a CANCELLED prompt is unchanged: stays locked') proves the catch is NOT inside
//     getRefreshToken.
//   - the locked short-circuit (getAuthToken returns undefined, no keychain read while
//     'locked') → authUnlock.logic.test.ts:250 already pins auth.ts's locked guard.
// -------------------------------------------------------------------------------------
describe('WHIT-270 (folded from authRestoreResaveGaps.logic.test.ts)', () => {
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

  // [G5] WHIT-274 — the seed pin. On the flag-off NON-ROTATING path the first restore reads
  // the keychain once and re-saves the token unguarded. The fix seeds session.refreshToken so
  // the NEXT hourly refresh reuses memory — no second keychain read, no second resave. Without
  // the seed, cacheToken leaves session.refreshToken undefined (a refresh omits it and there's
  // nothing to fall back to), so every hourly refresh re-enters the keychain-read branch and
  // re-runs resaveUnguarded (delete + create) forever. Fail-on-revert: drop the `session = {…}`
  // seed → the second getAuthToken re-reads the keychain → reads==2 and a second delete/write,
  // and each count assertion below fails.
  describe('WHIT-274 — flag-off non-rotating restore seeds memory for the hourly refresh', () => {
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

// -------------------------------------------------------------------------------------
// WHIT-274 (RE-HOMED here from authRestoreSeedGaps.logic.test.ts)
// Adversarial GAP tests for the flag-OFF restore SEED in src/auth.ts (refreshFromStoredToken
// seeds session.refreshToken after resaveUnguarded, ~line 735). Complements the [G5] pin in
// the WHIT-270 folded block above (OAuth, NON-rotating flag-off reuse) with the surfaces [G5]
// cannot reach from its harness:
//   [G6] the SRP / InitiateAuth refresh surface — [G5] only mocks the OAuth refreshAsync,
//        so it never proves the seed also spares the InitiateAuth (fetch) path a second
//        keychain read + resave. refreshTokens() routes on the stored auth method, so an
//        SRP session takes a DIFFERENT production code path (refreshViaInitiateAuth) whose
//        own cacheToken must preserve the seeded token across the hourly refresh.
//   [G7] a ROTATING flag-off restore, then a SECOND refresh — the seed plants the OLD 'R';
//        the rotation's cacheToken must OVERWRITE memory with 'R2' so the next refresh
//        redeems the ROTATED token, not the stale seeded one (the card's flagged risk:
//        "seeding a stale token a rotating refresh should replace"). No second keychain read.
// WHIT-459 re-home note: the audit mis-paired this with authPasswordEdges/cognito; its harness
// matches THIS auth-unlock/restore family. It needs the fetch + pool-id setup the InitiateAuth
// path uses — carried in this block's OWN beforeEach/afterEach so the survivor and the other
// folded gaps never see a mocked fetch or POOL_ID.
// -------------------------------------------------------------------------------------
describe('WHIT-274 (folded from authRestoreSeedGaps.logic.test.ts)', () => {
  function refreshTokenWrites() {
    return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
  }
  function refreshTokenDeletes() {
    return mockDeleteItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
  }

  beforeEach(() => {
    jest.resetModules();
    mockPlatformOS = 'ios';
    mockRefresh.mockReset();
    mockGetItem.mockReset().mockResolvedValue(null);
    mockSetItem.mockReset().mockResolvedValue(undefined);
    mockDeleteItem.mockReset().mockResolvedValue(undefined);
    mockCanUseBiometric.mockReset().mockReturnValue(false);
    mockFetch = jest.fn<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
    (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
    process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
    process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
    process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = POOL_ID;
  });
  afterEach(() => {
    delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
    delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
    delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
    delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
  });

  // [G6] The seed on the SRP / InitiateAuth surface. The stored auth method is 'srp', so the
  // cold restore refreshes via refreshViaInitiateAuth (fetch), NOT the OAuth grant [G5] mocks.
  // The first InitiateAuth response is deliberately short-lived (ExpiresIn 30s < the 60s skew)
  // so the id token is born already near-expiry and the SECOND getAuthToken forces a genuine
  // second refresh. The seed must let that second refresh reuse the in-memory 'R': no second
  // keychain read of the refresh token, no second resave (delete+create), and the InitiateAuth
  // body must carry the reused 'R'. Fail-on-revert: drop the `session = {…}` seed at auth.ts
  // ~735 → the second refreshFromStoredToken re-enters the keychain-read branch → reads==2,
  // deletes==2, writes==2 → every count assertion below fails.
  describe('WHIT-274 — the seed spares the SRP / InitiateAuth path a second read + resave', () => {
    it('a second InitiateAuth refresh reuses the in-memory token; keychain touched once', async () => {
      mockGetItem.mockImplementation(async (k) => {
        if (k === REFRESH_KEY) return 'R';
        if (k === METHOD_KEY) return 'srp'; // cold-launch provenance → InitiateAuth refresh
        return null;
      });
      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID1', AccessToken: 'A', ExpiresIn: 30 } }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID2', AccessToken: 'A2', ExpiresIn: 3600 } }) });
      const auth = loadAuth();

      await expect(auth.restoreSession()).resolves.toBe(true);
      expect(auth.getStatus()).toBe('authed');

      // The short-lived first token forces a real second swap through InitiateAuth.
      await expect(auth.getAuthToken()).resolves.toBe('ID2');

      expect(refreshReads()).toHaveLength(1);        // keychain read only on the first restore
      expect(refreshTokenDeletes()).toHaveLength(1); // only the first restore's resave delete
      expect(refreshTokenWrites()).toHaveLength(1);  // only the first restore's resave create
      expect(mockFetch).toHaveBeenCalledTimes(2);    // two genuine InitiateAuth refreshes
      // The second refresh redeemed the reused in-memory token, not a fresh keychain read.
      const body = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body) as {
        AuthParameters: { REFRESH_TOKEN: string };
      };
      expect(body.AuthParameters.REFRESH_TOKEN).toBe('R');
    });
  });

  // [G7] A ROTATING flag-off restore, then the hourly refresh. The seed plants the OLD token
  // 'R' in memory BEFORE the refresh; the rotation returns 'R2', and cacheToken's
  // `token.refreshToken ?? session?.refreshToken` must OVERWRITE the seed so the NEXT refresh
  // redeems 'R2', never the stale seeded 'R'. This is the card's flagged risk. The second
  // refresh must also reuse memory — no second keychain read. NOTE its fail-on-revert target
  // is cacheToken's rotation preference (flip it to `session?.refreshToken ?? token.refreshToken`
  // → the second refresh redeems 'R' → the 'R2' assertion fails), NOT the seed line: on a
  // rotating restore the rotation's own cacheToken re-seeds memory even without the [G6]/[G5]
  // seed, so reads==1 holds either way here — stated honestly.
  describe('WHIT-274 — a rotating restore replaces the seeded token; next refresh uses the rotated one', () => {
    it('the second refresh redeems R2 (not the stale seeded R) with no extra keychain read', async () => {
      mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null)); // method null → OAuth
      mockRefresh
        // First (restore) refresh ROTATES to R2 and hands back a near-expiry id token so the
        // second getAuthToken must refresh again.
        .mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', refreshToken: 'R2', issuedAt: nowSec() - 4000, expiresIn: 3600 })
        // Second refresh is non-rotating and fresh.
        .mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
      const auth = loadAuth();

      await expect(auth.restoreSession()).resolves.toBe(true);
      expect(auth.getStatus()).toBe('authed');
      expect(refreshReads()).toHaveLength(1);

      await expect(auth.getAuthToken()).resolves.toBe('ID2');

      expect(refreshReads()).toHaveLength(1); // still one — the rotated token lives in memory
      // The stale seeded 'R' was replaced: the second refresh redeems the ROTATED 'R2'.
      expect((mockRefresh.mock.calls[1][0] as { refreshToken: string }).refreshToken).toBe('R2');
    });
  });
});
