// WHIT-180 — getCurrentUser decodes the cached Cognito ID token into the signed-in
// identity (email always; name/picture from Google). Null when signed out or on a
// decode error. Seats a session via signInWithPassword (mocked SDK), then reads it.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { fakeSession, loadAuth } from './support/authModule';

const mockAuthenticateUser =
  jest.fn<(details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void>();
const mockDecodePayload = jest.fn<() => Record<string, string | undefined>>();
jest.mock('amazon-cognito-identity-js', () =>
  require('./support/authModule').cognitoMock({ authenticateUser: mockAuthenticateUser, decodePayload: mockDecodePayload }),
);

jest.mock('expo-secure-store', () => require('./support/authModule').secureStoreMock());

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

  it('returns null (never throws) when the token cannot be decoded', async () => {
    const auth = loadAuth();
    await signInSeat(auth);
    mockDecodePayload.mockImplementation(() => {
      throw new Error('bad token');
    });
    expect(auth.getCurrentUser()).toBeNull();
  });

  it('coerces non-string claims to undefined (malformed token → nothing weird in the UI)', async () => {
    const auth = loadAuth();
    await signInSeat(auth);
    mockDecodePayload.mockReturnValue({ email: 123 as unknown as string, name: { x: 1 } as unknown as string });
    expect(auth.getCurrentUser()).toEqual({ email: undefined, name: undefined, picture: undefined });
  });
});
