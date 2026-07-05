// WHIT-178 — adversarial edge tests for native email/password sign-in, companion to
// authPassword.logic.test.ts (does NOT duplicate its 10 cases). Covers: sign-in
// single-flight + lock-release, InitiateAuth refresh failure modes (malformed / !ok /
// fetch-throw / rotated-vs-omitted refresh token), the in-memory-provenance guard that
// keeps an SRP session on the InitiateAuth path even when the method-key read fails
// (QA #2 fix), the partial-seat ROLLBACK (QA #1 fix), email normalisation (QA #3),
// the defensive unsupported-challenge + synchronous-throw handling, and the un-hit
// mapCognitoError branches. SDK / SecureStore / fetch mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAuthenticateUser =
  jest.fn<(details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void>();
const mockAuthDetails = jest.fn<(cfg: unknown) => void>();
jest.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {},
  AuthenticationDetails: class {
    constructor(cfg: unknown) {
      mockAuthDetails(cfg);
    }
  },
  CognitoUser: class {
    authenticateUser = mockAuthenticateUser;
  },
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

const mockRefreshAsync = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {},
  exchangeCodeAsync: jest.fn(),
  refreshAsync: (...a: unknown[]) => mockRefreshAsync(...a),
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const METHOD_KEY = 'whittle.cognito.authMethod';
const POOL_ID = 'ap-southeast-2_abc123';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

let mockFetch: jest.Mock<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>;

function fakeSession(idJwt: string, accessJwt: string, claims: unknown, refresh: string) {
  return {
    getIdToken: () => ({ getJwtToken: () => idJwt, decodePayload: () => claims }),
    getAccessToken: () => ({ getJwtToken: () => accessJwt }),
    getRefreshToken: () => ({ getToken: () => refresh }),
  };
}
const freshClaims = () => ({ iat: nowSec(), exp: nowSec() + 3600 });
const expiredClaims = () => ({ iat: nowSec() - 4000, exp: nowSec() - 400 });

beforeEach(() => {
  jest.resetModules();
  mockAuthenticateUser.mockReset();
  mockAuthDetails.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
  mockRefreshAsync.mockReset();
  mockFetch = jest.fn<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
  (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = 'https://whittle-auth.auth.ap-southeast-2.amazoncognito.com';
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = POOL_ID;
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
});

describe('single-flight (double-tap)', () => {
  it('shares ONE authenticate attempt for overlapping calls, then releases the lock', async () => {
    let cb: Record<string, (arg?: unknown) => void> | undefined;
    mockAuthenticateUser.mockImplementation((_d, c) => {
      cb = c;
    });
    const auth = loadAuth();

    const p1 = auth.signInWithPassword('me@x.com', 'pw');
    const p2 = auth.signInWithPassword('me@x.com', 'pw');
    expect(mockAuthenticateUser).toHaveBeenCalledTimes(1); // fail-on-revert: no signInInFlight → 2
    expect(p1).toBe(p2);

    cb!.onSuccess!(fakeSession('IDTOK', 'AC', freshClaims(), 'R'));
    await expect(p1).resolves.toEqual({ ok: true });

    // lock released → a separate later sign-in runs again
    mockAuthenticateUser.mockImplementation((_d, c) => c.onSuccess!(fakeSession('ID2', 'AC', freshClaims(), 'R2')));
    await auth.signInWithPassword('me@x.com', 'pw');
    expect(mockAuthenticateUser).toHaveBeenCalledTimes(2);
  });

  it('a failed attempt releases the lock and can be retried', async () => {
    mockAuthenticateUser.mockImplementationOnce((_d, c) => c.onFailure!({ code: 'NotAuthorizedException' }));
    const auth = loadAuth();
    await expect(auth.signInWithPassword('me@x.com', 'wrong')).resolves.toMatchObject({ ok: false });

    mockAuthenticateUser.mockImplementationOnce((_d, c) => c.onSuccess!(fakeSession('IDTOK', 'AC', freshClaims(), 'R')));
    await expect(auth.signInWithPassword('me@x.com', 'right')).resolves.toEqual({ ok: true });
    expect(auth.getStatus()).toBe('authed');
  });
});

describe('email normalisation', () => {
  it('trims + lower-cases the email before authenticating', async () => {
    mockAuthenticateUser.mockImplementation((_d, c) => c.onSuccess!(fakeSession('ID', 'AC', freshClaims(), 'R')));
    await loadAuth().signInWithPassword('  Me@X.COM  ', 'pw');
    expect(mockAuthDetails).toHaveBeenCalledWith(expect.objectContaining({ Username: 'me@x.com' }));
  });
});

describe('SRP InitiateAuth refresh — failure modes', () => {
  async function seatExpiredSrp(auth: typeof import('../auth')) {
    mockAuthenticateUser.mockImplementation((_d, c) => c.onSuccess!(fakeSession('ID_OLD', 'AC', expiredClaims(), 'REFRESHTOK')));
    await auth.signInWithPassword('me@x.com', 'pw');
  }

  it('a !ok response → no token, session cleared to anon, never throws', async () => {
    const auth = loadAuth();
    await seatExpiredSrp(auth);
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    expect(auth.getStatus()).toBe('anon');
  });

  it('a 200 with no IdToken → undefined, anon', async () => {
    const auth = loadAuth();
    await seatExpiredSrp(auth);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ AuthenticationResult: { AccessToken: 'a' } }) });
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
    expect(auth.getStatus()).toBe('anon');
  });

  it('fetch itself rejecting (offline) → undefined, never throws', async () => {
    const auth = loadAuth();
    await seatExpiredSrp(auth);
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });

  it('a ROTATED refresh token in the response is persisted', async () => {
    const auth = loadAuth();
    await seatExpiredSrp(auth);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ AuthenticationResult: { IdToken: 'ID_NEW', ExpiresIn: 3600, RefreshToken: 'ROTATED' } }),
    });
    await expect(auth.getAuthToken()).resolves.toBe('ID_NEW');
    const refreshWrites = mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY).map((c) => c[1]);
    expect(refreshWrites[refreshWrites.length - 1]).toBe('ROTATED');
  });

  it('an OMITTED refresh token does NOT rewrite the stored one', async () => {
    const auth = loadAuth();
    await seatExpiredSrp(auth);
    const before = mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY).length;
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID_NEW', ExpiresIn: 3600 } }) });
    await expect(auth.getAuthToken()).resolves.toBe('ID_NEW');
    const after = mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY).length;
    expect(after).toBe(before);
  });
});

describe('provenance is robust to a method-key read failure (QA #2 fix)', () => {
  it('keeps an SRP session on the InitiateAuth path even when the method-key read throws', async () => {
    // In-memory provenance (set at seat) must win over the failed stored read, so the
    // SRP token is NOT mis-routed to /oauth2/token. Fail-on-revert: drop the in-memory
    // `sessionAuthMethod ??` and this session logs out via the OAuth path.
    mockAuthenticateUser.mockImplementation((_d, c) => c.onSuccess!(fakeSession('ID_OLD', 'AC', expiredClaims(), 'REFRESHTOK')));
    mockGetItem.mockImplementation((k) =>
      k === METHOD_KEY ? Promise.reject(new Error('keychain read failed')) : Promise.resolve(null),
    );
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID_NEW', ExpiresIn: 3600 } }) });
    const auth = loadAuth();
    await auth.signInWithPassword('me@x.com', 'pw');

    await expect(auth.getAuthToken()).resolves.toBe('ID_NEW');
    expect(mockFetch).toHaveBeenCalled();
    expect(mockRefreshAsync).not.toHaveBeenCalled();
  });
});

describe('partial-seat rollback (QA #1 fix)', () => {
  it('a failed keychain write → ok:false, not authed, and the partial session is rolled back', async () => {
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    mockAuthenticateUser.mockImplementation((_d, c) => c.onSuccess!(fakeSession('IDTOK', 'AC', freshClaims(), 'R')));
    const auth = loadAuth();

    await expect(auth.signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/finish signing in/i),
    });
    expect(auth.getStatus()).not.toBe('authed');
    // rollback deleted the stored keys → no zombie session to mis-restore next launch
    expect(mockDeleteItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([REFRESH_KEY]));
    await expect(auth.getAuthToken()).resolves.toBeUndefined();
  });
});

describe('defensive challenge + synchronous-throw handling', () => {
  it('an unsupported MFA challenge resolves to a friendly error, seats nothing', async () => {
    mockAuthenticateUser.mockImplementation((_d, c) => c.mfaRequired!({}));
    const auth = loadAuth();
    await expect(auth.signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/doesn't support/i),
    });
    expect(auth.getStatus()).not.toBe('authed');
  });

  it('a synchronous SDK throw (e.g. crypto polyfill missing) is caught → ok:false, no crash', async () => {
    mockAuthenticateUser.mockImplementation(() => {
      throw new TypeError('crypto.getRandomValues is not a function');
    });
    const auth = loadAuth();
    await expect(auth.signInWithPassword('me@x.com', 'pw')).resolves.toMatchObject({ ok: false });
    expect(auth.getStatus()).not.toBe('authed');
  });
});

describe('mapCognitoError — the branches the base suite does not hit', () => {
  it('NotAuthorized with "attempts exceeded" → back-off message', async () => {
    mockAuthenticateUser.mockImplementation((_d, c) => c.onFailure!({ code: 'NotAuthorizedException', message: 'Password attempts exceeded' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({ ok: false, error: expect.stringMatching(/too many/i) });
  });

  it('UserNotConfirmed → a "not verified" message', async () => {
    mockAuthenticateUser.mockImplementation((_d, c) => c.onFailure!({ code: 'UserNotConfirmedException' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({ ok: false, error: expect.stringMatching(/verified/i) });
  });

  it('PasswordResetRequired → a "reset your password" message', async () => {
    mockAuthenticateUser.mockImplementation((_d, c) => c.onFailure!({ code: 'PasswordResetRequiredException' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({ ok: false, error: expect.stringMatching(/reset your password/i) });
  });
});
