// WHIT-181 — completeNewPassword: finish Cognito's NEW_PASSWORD_REQUIRED challenge
// against the SAME attempt that signInWithPassword stashed. Success seats the session
// and clears the pending challenge; a weak password keeps the challenge alive for a
// retry; no pending challenge → "sign in again". SDK + SecureStore mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REFRESH_KEY, fakeSession, loadAuth } from './support/authModule';

const mockAuthenticateUser =
  jest.fn<(details: unknown, cb: Record<string, (arg?: unknown) => void>) => void>();
const mockCompleteChallenge =
  jest.fn<(pw: string, attrs: unknown, cb: Record<string, (arg?: unknown) => void>) => void>();
jest.mock('amazon-cognito-identity-js', () =>
  require('./support/authModule').cognitoMock({
    authenticateUser: mockAuthenticateUser,
    completeNewPasswordChallenge: mockCompleteChallenge,
  }),
);

const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
jest.mock('expo-secure-store', () =>
  require('./support/authModule').secureStoreMock({ setItem: mockSetItem, deleteItem: mockDeleteItem }),
);

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
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
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
    mockCompleteChallenge.mockImplementation((_pw, _attrs, cb) => cb.onSuccess!(fakeSession('IDTOK', 'AC', undefined, 'REFRESHTOK')));

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
    mockCompleteChallenge.mockImplementationOnce((_pw, _attrs, cb) => cb.onSuccess!(fakeSession('IDTOK', 'AC', undefined, 'REFRESHTOK')));
    await expect(auth.completeNewPassword('Str0ng#Pass')).resolves.toEqual({ ok: true });
    expect(auth.getStatus()).toBe('authed');
  });

  it('rolls back a partial seat (keychain write fails) — no orphaned session, not authed', async () => {
    const auth = loadAuth();
    await reachChallenge(auth);
    mockSetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) throw new Error('keychain write denied');
    });
    mockCompleteChallenge.mockImplementation((_pw, _attrs, cb) => cb.onSuccess!(fakeSession('IDTOK', 'AC', undefined, 'REFRESHTOK')));

    await expect(auth.completeNewPassword('Str0ng#Pass')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/finish signing in/i),
    });
    expect(auth.getStatus()).not.toBe('authed');
    // rollback deleted the stored keys so nothing orphaned survives to next launch
    expect(mockDeleteItem.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([REFRESH_KEY]));
  });

});
