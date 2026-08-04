// WHIT-448 — the SRP / InitiateAuth token refresh reads its body with no fetch-level timeout, so a
// 2xx whose body never finishes streaming would hang token refresh forever (the getAuthToken promise
// never settles → the auth gate never resolves). withBodyTimeout bounds it, like the API readers.
// refreshViaInitiateAuth is internal, so we drive it through the public getAuthToken; the storage
// method key routes to the SRP (fetch) refresh path. Harness mirrors authRestoreSeedGaps.logic.test.ts.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class { codeVerifier = 'verifier'; promptAsync = jest.fn(); },
  exchangeCodeAsync: jest.fn(),
  refreshAsync: jest.fn(),
}));

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => mockGetItem(...(a as [string, unknown])),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
  canUseBiometricAuthentication: () => false,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

jest.mock('react-native', () => ({ Platform: { get OS() { return 'ios'; } } }));

const REFRESH_KEY = 'abundo.cognito.refreshToken';
const METHOD_KEY = 'abundo.cognito.authMethod';
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  mockGetItem.mockReset().mockImplementation(async (k) => {
    if (k === REFRESH_KEY) return 'R';
    if (k === METHOD_KEY) return 'srp';   // cold-launch provenance → the InitiateAuth (fetch) refresh
    return null;
  });
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = 'ap-southeast-2_pool123';
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
});

describe('InitiateAuth refresh body-read timeout (WHIT-448)', () => {
  // Fail-on-revert: drop withBodyTimeout from the res.json() read → the stalled body never settles →
  // getAuthToken never resolves → the explicit 3s test cap trips it red instead of hanging the runner.
  it('resolves undefined when the refresh body stalls forever, on the 15s budget', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      json: () => new Promise(() => {}),   // headers arrived; the body never settles
    }));
    const auth = loadAuth();

    const pending = auth.getAuthToken();
    const resolves = expect(pending).resolves.toBeUndefined();   // refresh gives up → no token
    await jest.advanceTimersByTimeAsync(0);        // flush the keychain reads + the fetch resolve
    await jest.advanceTimersByTimeAsync(15_000);   // trip the body-read timeout
    await resolves;
  }, 3000);

  it('returns the refreshed id token when the body arrives in time', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ AuthenticationResult: { IdToken: 'ID-fresh', AccessToken: 'A', ExpiresIn: 3600 } }),
    }));
    const auth = loadAuth();

    const pending = auth.getAuthToken();
    await jest.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe('ID-fresh');   // a fast body is not clipped by the timeout
    await jest.advanceTimersByTimeAsync(20_000);        // the read settled; nothing left to fire
  });
});
