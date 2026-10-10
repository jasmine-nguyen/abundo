// WHIT-179 — native "Continue with Google": the Hosted-UI PKCE flow with
// identity_provider=Google so Cognito jumps STRAIGHT to Google's sheet (no chooser
// page). Asserts — fail-on-revert — that the request pins identity_provider=Google
// (drop the pin and the first test goes red), and that a successful code exchange
// seats an OAuth session (so it refreshes via /oauth2/token, not InitiateAuth).
// expo-auth-session + expo-secure-store mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { REFRESH_KEY, SENTINEL_KEY, METHOD_KEY, loadAuth, nowSec } from './support/authModule';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAuthRequestCfg = jest.fn<(cfg: unknown) => void>();
jest.mock('expo-auth-session', () =>
  require('./support/authModule').authSessionMock({ promptAsync: mockPromptAsync, exchange: mockExchange, onAuthRequest: mockAuthRequestCfg }),
);

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
jest.mock('expo-secure-store', () =>
  require('./support/authModule').secureStoreMock({ getItem: mockGetItem, setItem: mockSetItem, deleteItem: mockDeleteItem }),
);

const GENERIC = "Couldn't complete Google sign-in. Please try again.";

function promptOkExchangeOk() {
  mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: 'CODE' } });
  mockExchange.mockResolvedValue({ idToken: 'IDTOK', accessToken: 'AC', refreshToken: 'REFRESHTOK', issuedAt: nowSec(), expiresIn: 3600 });
}

beforeEach(() => {
  jest.resetModules();
  mockPromptAsync.mockReset();
  mockExchange.mockReset();
  mockAuthRequestCfg.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = 'https://abundo-auth.auth.ap-southeast-2.amazoncognito.com';
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
});

describe('signInWithGoogle', () => {
  it('pins identity_provider=Google on the authorize request (straight to Google, no chooser)', async () => {
    promptOkExchangeOk();
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: true });
    expect(mockAuthRequestCfg).toHaveBeenCalledWith(
      expect.objectContaining({ extraParams: { identity_provider: 'Google' }, usePKCE: true }),
    );
  });

  it('seats the Google session as an OAuth session (refresh token + oauth provenance + sentinel, authed)', async () => {
    promptOkExchangeOk();
    const auth = loadAuth();
    await auth.signInWithGoogle();

    const writes = Object.fromEntries(mockSetItem.mock.calls.map((c) => [c[0], c[1]]));
    expect(writes[REFRESH_KEY]).toBe('REFRESHTOK');
    expect(writes[METHOD_KEY]).toBe('oauth'); // federated → /oauth2/token refresh path
    expect(writes[SENTINEL_KEY]).toBe('1');
    expect(auth.getStatus()).toBe('authed');
    await expect(auth.getAuthToken()).resolves.toBe('IDTOK');
  });

  it('a prompt error (not a cancel) returns the generic failure message', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'error' });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false, error: GENERIC });
    expect(auth.getStatus()).not.toBe('authed');
  });

  // [A8] the old code returned a bare false here, which the screen treats as a silent cancel.
  it("a 'success' with an empty params.code is a failure, not a silent cancel", async () => {
    mockPromptAsync.mockResolvedValue({ type: 'success', params: { code: '' } });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toEqual({ ok: false, error: GENERIC });
    expect(mockExchange).not.toHaveBeenCalled();
  });
});
