// WHIT-161 — unit tests for the Face ID / biometric-lock logic in src/auth.ts.
// expo-secure-store + expo-auth-session are mocked; no keychain, no network, no
// prompt. Covers: guarded storage options gated on flag + capability; the sentinel
// written/read in lockstep; unlock success/cancel/invalidated; the ONE-TIME unlock
// (no re-read on the next refresh); lock(); canBiometricLock; unlockOrRestore routing.
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

/** getItemAsync calls made against the guarded refresh-token key. */
function refreshReads() {
  return mockGetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}

beforeEach(() => {
  jest.resetModules();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockRefresh.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockClear();
  mockDeleteItem.mockClear();
  mockCanUseBiometric.mockReset().mockReturnValue(false);
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
});

async function signInOk(auth: typeof import('../auth')) {
  mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'C' } });
  mockExchange.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R', issuedAt: nowSec(), expiresIn: 3600 });
  await auth.signIn();
}

describe('guarded storage options', () => {
  it('stores UNGUARDED (no requireAuthentication) when the biometric flag is off', async () => {
    const auth = loadAuth();
    await signInOk(auth);
    const write = mockSetItem.mock.calls.find((c) => c[0] === REFRESH_KEY)!;
    expect(write[2]).toEqual({});
    // WHIT-170: the delete-then-create dance is guarded-only — an unguarded write
    // never prompts, so it must NOT delete the key first.
    expect(mockDeleteItem.mock.calls.filter((c) => c[0] === REFRESH_KEY)).toHaveLength(0);
  });

  it('stores GUARDED (requireAuthentication) when flag on AND device supports biometrics', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    const auth = loadAuth();
    await signInOk(auth);
    const write = mockSetItem.mock.calls.find((c) => c[0] === REFRESH_KEY)!;
    expect(write[2]).toMatchObject({ requireAuthentication: true, keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
  });

  it('stores UNGUARDED when flag on but device cannot use biometrics (never lock out)', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(false);
    const auth = loadAuth();
    await signInOk(auth);
    const write = mockSetItem.mock.calls.find((c) => c[0] === REFRESH_KEY)!;
    expect(write[2]).toEqual({});
  });
});

describe('sentinel lockstep', () => {
  it('signIn writes the token AND the unguarded sentinel; hasStoredSession reads the sentinel key (never the guarded key)', async () => {
    const auth = loadAuth();
    await signInOk(auth);
    expect(mockSetItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([REFRESH_KEY, SENTINEL_KEY]));
    const sentinelWrite = mockSetItem.mock.calls.find((c) => c[0] === SENTINEL_KEY)!;
    expect(sentinelWrite[1]).toBe('1');
    expect(sentinelWrite[2]).toBeUndefined(); // unguarded

    mockGetItem.mockImplementation(async (k) => (k === SENTINEL_KEY ? '1' : null));
    await expect(auth.hasStoredSession()).resolves.toBe(true);
    expect(refreshReads()).toHaveLength(0); // never touched the guarded key
  });

  it('signOut deletes BOTH the sentinel and the token', async () => {
    const auth = loadAuth();
    await auth.signOut();
    const deleted = mockDeleteItem.mock.calls.map((c) => c[0]);
    expect(deleted).toEqual(expect.arrayContaining([SENTINEL_KEY, REFRESH_KEY]));
  });
});

describe('unlock', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
  });

  it('reads the guarded token (the prompt) and refreshes → authed', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.unlock()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    // the guarded read happened, with the biometric options
    expect(refreshReads()[0][1]).toMatchObject({ requireAuthentication: true });
  });

  it('offline unlock (guarded read OK, refresh FAILS) stays locked WITHOUT flashing anon', async () => {
    // WHIT-171: on a good biometric read but a failed refresh (offline), unlock must
    // own the terminal 'locked' status. The old shared refresh path called
    // clearSession() → broadcast a transient 'anon' before unlock re-set 'locked', so
    // the gate rendered one Redirect('/') login-flash frame. Fail-on-revert: routing
    // performUnlock back through refreshFromStoredToken makes 'anon' reappear here.
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockRejectedValue(new Error('offline'));
    const auth = loadAuth();

    const seen: string[] = [];
    auth.subscribe(() => seen.push(auth.getStatus()));

    await expect(auth.unlock()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('locked');
    expect(seen).not.toContain('anon'); // no login-redirect flash before the lock screen
  });

  it('WHIT-170: the guarded token write deletes-then-creates (silent CREATE, not a prompting UPDATE)', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R0' : null));
    // Rotation ON: the refresh response carries a NEW refresh token, so it is written
    // back — the exact path that would re-prompt Face ID via an in-place UPDATE.
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', refreshToken: 'R1', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.unlock()).resolves.toBe(true);
    // the rotated token was persisted...
    const rotatedSet = mockSetItem.mock.calls.find((c) => c[0] === REFRESH_KEY && c[1] === 'R1');
    expect(rotatedSet).toBeTruthy();
    // ...and its guarded write deleted the key FIRST (create path), so no update-prompt.
    const delIdx = mockDeleteItem.mock.calls.findIndex((c) => c[0] === REFRESH_KEY);
    const setIdx = mockSetItem.mock.calls.findIndex((c) => c[0] === REFRESH_KEY && c[1] === 'R1');
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(mockDeleteItem.mock.invocationCallOrder[delIdx]).toBeLessThan(
      mockSetItem.mock.invocationCallOrder[setIdx],
    );
  });

  it('stays LOCKED when the biometric read throws (user cancelled)', async () => {
    mockGetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('user cancelled');
      return null;
    });
    const auth = loadAuth();
    await expect(auth.unlock()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('locked');
  });

  it('re-logins (anon + clears stored) when the guarded read returns null (biometrics changed)', async () => {
    mockGetItem.mockResolvedValue(null); // invalidated key
    const auth = loadAuth();
    await expect(auth.unlock()).resolves.toBe(false);
    expect(auth.getStatus()).toBe('anon');
    expect(mockDeleteItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SENTINEL_KEY, REFRESH_KEY]));
  });

  it('is ONE-TIME: after unlock, the next refresh reuses the in-memory token (no second guarded read)', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    // First refresh (during unlock) returns an already-expired id token so the NEXT
    // getAuthToken must refresh again — and must do so WITHOUT re-reading the keychain.
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', issuedAt: nowSec() - 4000, expiresIn: 3600 });
    mockRefresh.mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlock();
    expect(refreshReads()).toHaveLength(1); // one guarded read during unlock

    await expect(auth.getAuthToken()).resolves.toBe('ID2');
    expect(refreshReads()).toHaveLength(1); // STILL one — used the in-memory refresh token
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('lock', () => {
  it('drops the in-memory session and re-seals to locked', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();
    await auth.unlock();
    expect(auth.getStatus()).toBe('authed');

    auth.lock();
    expect(auth.getStatus()).toBe('locked');
  });
});

describe('canBiometricLock', () => {
  it('false when flag off', () => {
    mockCanUseBiometric.mockReturnValue(true);
    expect(loadAuth().canBiometricLock()).toBe(false);
  });
  it('false when flag on but device unsupported', () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(false);
    expect(loadAuth().canBiometricLock()).toBe(false);
  });
  it('true when flag on and device supported', () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    expect(loadAuth().canBiometricLock()).toBe(true);
  });
});

describe('locked-state guards', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
  });

  it('getAuthToken returns undefined and does NOT read the guarded key while locked', async () => {
    const auth = loadAuth();
    auth.lock(); // status → 'locked'
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    expect(refreshReads()).toHaveLength(0); // no blind guarded read / Face ID prompt
  });

  it('unlock is single-flight: two concurrent calls share ONE guarded read (one prompt)', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    const first = auth.unlock();
    const second = auth.unlock();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(refreshReads()).toHaveLength(1); // stacked unlocks did not stack prompts
  });
});

describe('unlockOrRestore routing', () => {
  it('takes the biometric UNLOCK path (guarded read) when active + a stored session exists', async () => {
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === SENTINEL_KEY ? '1' : k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();
    expect(refreshReads()[0][1]).toMatchObject({ requireAuthentication: true }); // guarded read = unlock path
    expect(auth.getStatus()).toBe('authed');
  });

  it('cold launch pops EXACTLY ONE Face ID prompt — one guarded read, never a second', async () => {
    // Belt-and-suspenders against a launch prompt-loop (the reason biometrics were
    // switched off). A cold launch runs unlockOrRestore once (the gate's mount effect,
    // locked by authGateRestore.screen), and that path must read the biometric-guarded
    // token — which IS the Face ID prompt — EXACTLY ONCE. Not zero (no prompt / a broken
    // unlock) and not twice (a double-prompt on a single launch). Fail-on-revert: a
    // performUnlock that reads the guarded key more than once, or an unlockOrRestore that
    // invokes unlock more than once, flips this count off 1.
    process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED = 'true';
    mockCanUseBiometric.mockReturnValue(true);
    mockGetItem.mockImplementation(async (k) => (k === SENTINEL_KEY ? '1' : k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();

    expect(refreshReads()).toHaveLength(1); // one launch → exactly one prompt
    expect(auth.getStatus()).toBe('authed');
  });

  it('takes the normal RESTORE path (unguarded read) when biometrics are off', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null));
    mockRefresh.mockResolvedValue({ idToken: 'ID', accessToken: 'A', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await auth.unlockOrRestore();
    // every read of the refresh key was unguarded (no requireAuthentication)
    expect(refreshReads().every((c) => !(c[1] as { requireAuthentication?: boolean })?.requireAuthentication)).toBe(true);
    expect(auth.getStatus()).toBe('authed');
  });
});
