// WHIT-181 — completeNewPassword: finish Cognito's NEW_PASSWORD_REQUIRED challenge
// against the SAME attempt that signInWithPassword stashed. Success seats the session
// and clears the pending challenge; a weak password keeps the challenge alive for a
// retry; no pending challenge → "sign in again". SDK + SecureStore mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAuthenticateUser =
  jest.fn<(details: unknown, cb: Record<string, (arg?: unknown) => void>) => void>();
const mockCompleteChallenge =
  jest.fn<(pw: string, attrs: unknown, cb: Record<string, (arg?: unknown) => void>) => void>();
jest.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {},
  AuthenticationDetails: class {},
  CognitoUser: class {
    authenticateUser = mockAuthenticateUser;
    completeNewPasswordChallenge = mockCompleteChallenge;
  },
}));

const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: (...a: unknown[]) => mockSetItem(...(a as [string, string, unknown])),
  deleteItemAsync: jest.fn(async () => undefined),
  canUseBiometricAuthentication: () => false,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

function fakeSession() {
  return {
    getIdToken: () => ({ getJwtToken: () => 'IDTOK', decodePayload: () => ({ iat: nowSec(), exp: nowSec() + 3600 }) }),
    getAccessToken: () => ({ getJwtToken: () => 'AC' }),
    getRefreshToken: () => ({ getToken: () => 'REFRESHTOK' }),
  };
}

// Drive signInWithPassword to the NEW_PASSWORD_REQUIRED challenge, which stashes the
// CognitoUser for completeNewPassword.
async function reachChallenge(auth: typeof import('../auth')) {
  mockAuthenticateUser.mockImplementation((_d, cb) => cb.newPasswordRequired!({}));
  await expect(auth.signInWithPassword('me@x.com', 'Temp#123')).resolves.toEqual({
    ok: false,
    challenge: 'NEW_PASSWORD_REQUIRED',
  });
}

beforeEach(() => {
  jest.resetModules();
  mockAuthenticateUser.mockReset();
  mockCompleteChallenge.mockReset();
  mockSetItem.mockClear();
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = 'ap-southeast-2_abc';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
});

describe('completeNewPassword', () => {
  it('sets the password against the pending challenge, seats the session, and goes authed', async () => {
    const auth = loadAuth();
    await reachChallenge(auth);
    mockCompleteChallenge.mockImplementation((_pw, _attrs, cb) => cb.onSuccess!(fakeSession()));

    await expect(auth.completeNewPassword('Str0ng#Pass')).resolves.toEqual({ ok: true });
    expect(mockCompleteChallenge).toHaveBeenCalledWith('Str0ng#Pass', {}, expect.anything());
    expect(auth.getStatus()).toBe('authed');
    expect(mockSetItem.mock.calls.some((c) => c[0] === REFRESH_KEY && c[1] === 'REFRESHTOK')).toBe(true);
  });

  it('with no pending challenge → asks the user to sign in again, never calls the SDK', async () => {
    const auth = loadAuth();
    await expect(auth.completeNewPassword('Whatever#1')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/sign in again/i),
    });
    expect(mockCompleteChallenge).not.toHaveBeenCalled();
  });

  it('a too-weak password maps to a friendly error and KEEPS the challenge alive for retry', async () => {
    const auth = loadAuth();
    await reachChallenge(auth);

    mockCompleteChallenge.mockImplementationOnce((_pw, _attrs, cb) => cb.onFailure!({ code: 'InvalidPasswordException' }));
    await expect(auth.completeNewPassword('weak')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/requirements/i),
    });
    expect(auth.getStatus()).not.toBe('authed');

    // Retry against the SAME challenge (not cleared) → succeeds.
    mockCompleteChallenge.mockImplementationOnce((_pw, _attrs, cb) => cb.onSuccess!(fakeSession()));
    await expect(auth.completeNewPassword('Str0ng#Pass')).resolves.toEqual({ ok: true });
    expect(auth.getStatus()).toBe('authed');
  });

  it('clears the pending challenge on success (a second complete → sign in again)', async () => {
    const auth = loadAuth();
    await reachChallenge(auth);
    mockCompleteChallenge.mockImplementation((_pw, _attrs, cb) => cb.onSuccess!(fakeSession()));
    await auth.completeNewPassword('Str0ng#Pass');

    await expect(auth.completeNewPassword('Again#123')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/sign in again/i),
    });
  });
});
