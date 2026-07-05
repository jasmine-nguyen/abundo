// WHIT-178 — unit tests for native email/password sign-in (`signInWithPassword`) in
// src/auth.ts. The Cognito SDK, expo-secure-store, expo-auth-session and fetch are
// mocked; no network, no keychain, no crypto. Covers: success seats the session and
// makes getAuthToken return the ID (not access) token; NEW_PASSWORD_REQUIRED is
// surfaced not swallowed; error mapping; missing config; the expiry math; and that an
// SRP session refreshes via InitiateAuth (fetch), NOT the OAuth /oauth2/token path.
//
// NOTE: two of WHIT-178's risks — the real SRP↔refresh-surface compatibility and the
// react-native-get-random-values polyfill — cannot be exercised here (SDK + fetch are
// mocked, polyfill lives in the app entry). Those are on-device manual gates.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAuthenticateUser =
  jest.fn<(details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void>();
jest.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {},
  AuthenticationDetails: class {},
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

// Present so we can assert the OAuth refresh path is NOT taken for an SRP session.
const mockRefreshAsync = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {},
  exchangeCodeAsync: jest.fn(),
  refreshAsync: (...a: unknown[]) => mockRefreshAsync(...a),
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const SENTINEL_KEY = 'whittle.cognito.hasSession';
const METHOD_KEY = 'whittle.cognito.authMethod';
const POOL_ID = 'ap-southeast-2_abc123';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

let mockFetch: jest.Mock<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>;

/** A stand-in CognitoUserSession with the getters seatCognitoSession reads. */
function fakeSession(idJwt: string, accessJwt: string, claims: { iat: number; exp: number }, refresh: string) {
  return {
    getIdToken: () => ({ getJwtToken: () => idJwt, decodePayload: () => claims }),
    getAccessToken: () => ({ getJwtToken: () => accessJwt }),
    getRefreshToken: () => ({ getToken: () => refresh }),
  };
}

beforeEach(() => {
  jest.resetModules();
  mockAuthenticateUser.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockClear();
  mockDeleteItem.mockClear();
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

describe('signInWithPassword — success', () => {
  it('seats the session: refresh token + sentinel + srp method stored, status authed, getAuthToken returns the ID token', async () => {
    const claims = { iat: nowSec(), exp: nowSec() + 3600 };
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onSuccess!(fakeSession('IDTOK', 'ACCESSTOK', claims, 'REFRESHTOK')));
    const auth = loadAuth();

    await expect(auth.signInWithPassword('me@x.com', 'pw')).resolves.toEqual({ ok: true });
    expect(auth.getStatus()).toBe('authed');

    const writes = Object.fromEntries(mockSetItem.mock.calls.map((c) => [c[0], c[1]]));
    expect(writes[REFRESH_KEY]).toBe('REFRESHTOK');
    expect(writes[SENTINEL_KEY]).toBe('1');
    expect(writes[METHOD_KEY]).toBe('srp'); // provenance recorded for the refresh path

    // The API authorizer needs the ID token, never the access token (pins api.ts).
    await expect(auth.getAuthToken()).resolves.toBe('IDTOK');
    await expect(auth.getAuthToken()).resolves.not.toBe('ACCESSTOK');
  });

  it('writes the refresh token BEFORE the sentinel (landmine order)', async () => {
    const claims = { iat: nowSec(), exp: nowSec() + 3600 };
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onSuccess!(fakeSession('ID', 'AC', claims, 'R')));
    await loadAuth().signInWithPassword('me@x.com', 'pw');

    const order = mockSetItem.mock.calls.map((c) => c[0]);
    expect(order.indexOf(REFRESH_KEY)).toBeLessThan(order.indexOf(SENTINEL_KEY));
  });

  it('treats a token near its exp as near-expiry (issuedAt=iat, expiresIn=exp-iat)', async () => {
    // exp only 30s out (< the 60s skew) → getAuthToken must refresh rather than serve
    // the stale cached token. If the math used exp as the DURATION it would look valid
    // for ~an hour and never refresh.
    const claims = { iat: nowSec() - 3570, exp: nowSec() + 30 };
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onSuccess!(fakeSession('ID_STALE', 'AC', claims, 'R')));
    // route the ensuing refresh through InitiateAuth (srp) and return a fresh token
    mockGetItem.mockImplementation(async (k) => (k === METHOD_KEY ? 'srp' : null));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID_FRESH', AccessToken: 'AC2', ExpiresIn: 3600 } }) });
    const auth = loadAuth();

    await auth.signInWithPassword('me@x.com', 'pw');
    await expect(auth.getAuthToken()).resolves.toBe('ID_FRESH'); // refreshed, not the stale one
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('signInWithPassword — challenge + errors', () => {
  it('surfaces NEW_PASSWORD_REQUIRED without seating a session', async () => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.newPasswordRequired!({}));
    const auth = loadAuth();

    await expect(auth.signInWithPassword('me@x.com', 'temp')).resolves.toEqual({
      ok: false,
      challenge: 'NEW_PASSWORD_REQUIRED',
    });
    expect(auth.getStatus()).not.toBe('authed');
    // no session persisted on a challenge
    expect(mockSetItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(false);
  });

  it('maps a bad password to a generic, non-enumerating message', async () => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code: 'NotAuthorizedException', message: 'Incorrect username or password.' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'wrong')).resolves.toEqual({
      ok: false,
      error: 'Incorrect email or password.',
    });
  });

  it('maps UserNotFound to the SAME message as a bad password (no user enumeration)', async () => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code: 'UserNotFoundException' }));
    await expect(loadAuth().signInWithPassword('ghost@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: 'Incorrect email or password.',
    });
  });

  it('maps a network error to an offline message, and rate-limit to a back-off message', async () => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code: 'NetworkError' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/offline/i),
    });

    jest.resetModules();
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code: 'TooManyRequestsException' }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/too many/i),
    });
  });

  it('returns a config error and never calls the SDK when the pool id is missing', async () => {
    delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
    const auth = loadAuth();
    await expect(auth.signInWithPassword('me@x.com', 'pw')).resolves.toMatchObject({ ok: false });
    expect(mockAuthenticateUser).not.toHaveBeenCalled();
  });
});

describe('SRP refresh routing (WHIT-178)', () => {
  it('refreshes an SRP session via InitiateAuth (fetch), NOT the OAuth /oauth2/token path', async () => {
    // Seat an already-expired SRP session so the next getAuthToken must refresh.
    const claims = { iat: nowSec() - 4000, exp: nowSec() - 400 };
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onSuccess!(fakeSession('ID_OLD', 'AC', claims, 'REFRESHTOK')));
    mockGetItem.mockImplementation(async (k) => (k === METHOD_KEY ? 'srp' : null));
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID_NEW', ExpiresIn: 3600 } }) });
    const auth = loadAuth();

    await auth.signInWithPassword('me@x.com', 'pw');
    await expect(auth.getAuthToken()).resolves.toBe('ID_NEW');

    // Fail-on-revert: dropping the provenance routing sends this down refreshAsync.
    const url = mockFetch.mock.calls[0][0] as string;
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(url).toContain('cognito-idp.ap-southeast-2.amazonaws.com');
    expect(body.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    expect(mockRefreshAsync).not.toHaveBeenCalled();
  });
});

describe('node-safe import', () => {
  it('src/auth imports in the node logic project and exports signInWithPassword', () => {
    expect(typeof loadAuth().signInWithPassword).toBe('function');
  });
});
