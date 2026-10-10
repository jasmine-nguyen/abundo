// WHIT-182 — requestPasswordReset / confirmPasswordReset. Cognito emails a code, then
// the code + a new password reset it (stateless; never seats a session). SDK mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { loadAuth } from './support/authModule';

const mockForgotPassword = jest.fn<(cb: Record<string, (arg?: unknown) => void>) => void>();
const mockConfirmPassword =
  jest.fn<(code: string, newPw: string, cb: Record<string, (arg?: unknown) => void>) => void>();
const mockUserCtor = jest.fn<(cfg: unknown) => void>();
jest.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {},
  CognitoUser: class {
    constructor(cfg: unknown) {
      mockUserCtor(cfg);
    }
    forgotPassword = mockForgotPassword;
    confirmPassword = mockConfirmPassword;
  },
}));

beforeEach(() => {
  jest.resetModules();
  mockForgotPassword.mockReset();
  mockConfirmPassword.mockReset();
  mockUserCtor.mockReset();
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = 'ap-southeast-2_abc';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
});

describe('requestPasswordReset', () => {
  it('resolves ok when the code is sent (inputVerificationCode)', async () => {
    mockForgotPassword.mockImplementation((cb) => cb.inputVerificationCode!());
    await expect(loadAuth().requestPasswordReset('Me@X.com')).resolves.toEqual({ ok: true });
    // email normalised (trim + lower-case) for the Cognito username
    expect(mockUserCtor).toHaveBeenCalledWith(expect.objectContaining({ Username: 'me@x.com' }));
  });

  it('rejects an empty email without calling the SDK', async () => {
    await expect(loadAuth().requestPasswordReset('   ')).resolves.toMatchObject({ ok: false });
    expect(mockForgotPassword).not.toHaveBeenCalled();
  });
});

describe('confirmPasswordReset', () => {
  it('confirms with the trimmed code + new password → ok', async () => {
    mockConfirmPassword.mockImplementation((_code, _pw, cb) => cb.onSuccess!());
    await expect(loadAuth().confirmPasswordReset('me@x.com', ' 123456 ', 'Str0ng#Pass')).resolves.toEqual({ ok: true });
    expect(mockConfirmPassword).toHaveBeenCalledWith('123456', 'Str0ng#Pass', expect.anything());
  });

  it('maps a wrong code to a friendly error', async () => {
    mockConfirmPassword.mockImplementation((_c, _p, cb) => cb.onFailure!({ code: 'CodeMismatchException' }));
    await expect(loadAuth().confirmPasswordReset('me@x.com', '000000', 'Str0ng#Pass')).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/code isn.t right/i),
    });
  });
});
