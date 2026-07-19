// WHIT-179 — native "Continue with Google": the Hosted-UI PKCE flow with
// identity_provider=Google so Cognito jumps STRAIGHT to Google's sheet (no chooser
// page). Asserts the request pins identity_provider=Google, that a successful code
// exchange seats an OAuth session (so it refreshes via /oauth2/token, not InitiateAuth),
// and — fail-on-revert — that plain signIn() does NOT pin the provider. expo-auth-session
// + expo-secure-store mocked.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockPromptAsync = jest.fn<() => Promise<unknown>>();
const mockExchange = jest.fn<(...a: unknown[]) => Promise<unknown>>();
const mockAuthRequestCfg = jest.fn<(cfg: unknown) => void>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'verifier';
    promptAsync = mockPromptAsync;
    constructor(cfg: unknown) {
      mockAuthRequestCfg(cfg);
    }
  },
  exchangeCodeAsync: (...a: unknown[]) => mockExchange(...a),
  refreshAsync: jest.fn(),
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

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const SENTINEL_KEY = 'abundo.cognito.hasSession';
const METHOD_KEY = 'abundo.cognito.authMethod';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

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
    await expect(auth.signInWithGoogle()).resolves.toBe(true);
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

  it('a cancelled/dismissed prompt resolves false and seats nothing', async () => {
    mockPromptAsync.mockResolvedValue({ type: 'dismiss' });
    const auth = loadAuth();
    await expect(auth.signInWithGoogle()).resolves.toBe(false);
    expect(auth.getStatus()).not.toBe('authed');
    expect(mockSetItem.mock.calls.some((c) => c[0] === REFRESH_KEY)).toBe(false);
  });
});

describe('plain signIn (chooser) is unchanged', () => {
  it('does NOT pin identity_provider — proves signInWithGoogle is Google-specific', async () => {
    promptOkExchangeOk();
    const auth = loadAuth();
    await auth.signIn();
    const cfg = mockAuthRequestCfg.mock.calls[0][0] as { extraParams?: unknown };
    expect(cfg.extraParams).toBeUndefined();
  });
});
