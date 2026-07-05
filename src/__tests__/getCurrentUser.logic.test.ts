// WHIT-180 — getCurrentUser decodes the cached Cognito ID token into the signed-in
// identity (email always; name/picture from Google). Null when signed out or on a
// decode error. Seats a session via signInWithPassword (mocked SDK), then reads it.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAuthenticateUser =
  jest.fn<(details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void>();
const mockDecodePayload = jest.fn<() => Record<string, string | undefined>>();
jest.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class {},
  AuthenticationDetails: class {},
  CognitoUser: class {
    authenticateUser = mockAuthenticateUser;
  },
  // getCurrentUser decodes the raw id token through this.
  CognitoIdToken: class {
    constructor(_cfg: unknown) {}
    decodePayload = mockDecodePayload;
  },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  canUseBiometricAuthentication: () => false,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

function fakeSession(idJwt: string) {
  return {
    getIdToken: () => ({ getJwtToken: () => idJwt, decodePayload: () => ({ iat: nowSec(), exp: nowSec() + 3600 }) }),
    getAccessToken: () => ({ getJwtToken: () => 'AC' }),
    getRefreshToken: () => ({ getToken: () => 'R' }),
  };
}

async function signInSeat(auth: typeof import('../auth'), idJwt = 'IDTOK') {
  mockAuthenticateUser.mockImplementation((_d, cb) => cb.onSuccess!(fakeSession(idJwt)));
  await auth.signInWithPassword('me@x.com', 'pw');
}

beforeEach(() => {
  jest.resetModules();
  mockAuthenticateUser.mockReset();
  mockDecodePayload.mockReset();
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = 'ap-southeast-2_abc';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
});

describe('getCurrentUser', () => {
  it('is null when signed out', () => {
    expect(loadAuth().getCurrentUser()).toBeNull();
  });

  it('returns email + name + picture decoded from the cached id token', async () => {
    const auth = loadAuth();
    await signInSeat(auth);
    mockDecodePayload.mockReturnValue({ email: 'me@x.com', name: 'Jasmine Nguyen', picture: 'https://p/x.png' });
    expect(auth.getCurrentUser()).toEqual({ email: 'me@x.com', name: 'Jasmine Nguyen', picture: 'https://p/x.png' });
  });

  it('returns just the email when name/picture are absent (native password user)', async () => {
    const auth = loadAuth();
    await signInSeat(auth);
    mockDecodePayload.mockReturnValue({ email: 'me@x.com' });
    expect(auth.getCurrentUser()).toEqual({ email: 'me@x.com', name: undefined, picture: undefined });
  });

  it('returns null (never throws) when the token cannot be decoded', async () => {
    const auth = loadAuth();
    await signInSeat(auth);
    mockDecodePayload.mockImplementation(() => {
      throw new Error('bad token');
    });
    expect(auth.getCurrentUser()).toBeNull();
  });
});
