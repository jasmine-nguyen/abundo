// WHIT-178 — unit tests for native email/password sign-in (`signInWithPassword`) in
// src/auth.ts. The Cognito SDK, expo-secure-store, expo-auth-session and fetch are
// mocked; no network, no keychain, no crypto. Covers: success seats the session and
// makes getAuthToken return the ID (not access) token; NEW_PASSWORD_REQUIRED is
// surfaced not swallowed; error mapping; missing config; the expiry math; and that an
// SRP session refreshes via InitiateAuth (fetch), NOT the OAuth /oauth2/token path.
//
// NOTE: two of WHIT-178's risks — the real SRP↔refresh-surface compatibility and the
// expo-crypto getRandomValues polyfill — cannot be exercised here (SDK + fetch are
// mocked, polyfill lives in the app entry). Those are on-device manual gates.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REFRESH_KEY, SENTINEL_KEY, METHOD_KEY, fakeSession, loadAuth, nowSec } from './support/authModule';

const mockAuthenticateUser =
  jest.fn<(details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void>();
jest.mock('amazon-cognito-identity-js', () =>
  require('./support/authModule').cognitoMock({ authenticateUser: mockAuthenticateUser }),
);

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
jest.mock('expo-secure-store', () =>
  require('./support/authModule').secureStoreMock({ getItem: mockGetItem, setItem: mockSetItem, deleteItem: mockDeleteItem }),
);

// Present so we can assert the OAuth refresh path is NOT taken for an SRP session.
const mockRefreshAsync = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () =>
  require('./support/authModule').authSessionMock({ refresh: mockRefreshAsync }),
);

const POOL_ID = 'ap-southeast-2_abc123';

let mockFetch: jest.Mock<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>;

beforeEach(() => {
  jest.resetModules();
  mockAuthenticateUser.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockClear();
  mockDeleteItem.mockClear();
  mockRefreshAsync.mockReset();
  mockFetch = jest.fn<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
  (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
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

  it.each([
    ['NotAuthorizedException', 'Incorrect username or password.'],
    ['UserNotFoundException', ''],
  ])('maps %s to the SAME non-enumerating message', async (code, message) => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code, message }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: 'Incorrect email or password.',
    });
  });

  it.each([
    ['NetworkError', '', /offline/i],
    ['TooManyRequestsException', '', /too many/i],
    ['LimitExceededException', '', /too many/i],
    ['NotAuthorizedException', 'Password attempts exceeded', /too many/i],
    ['UserNotConfirmedException', '', /verified/i],
    ['PasswordResetRequiredException', '', /reset your password/i],
    ['InvalidPasswordException', '', /requirements/i],
    ['CodeMismatchException', '', /code isn.t right/i],
    ['ExpiredCodeException', '', /expired/i],
  ])('mapCognitoError: %s %s → %s', async (code, message, expected) => {
    mockAuthenticateUser.mockImplementation((_d, cb) => cb.onFailure!({ code, message }));
    await expect(loadAuth().signInWithPassword('me@x.com', 'pw')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(expected),
    });
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
