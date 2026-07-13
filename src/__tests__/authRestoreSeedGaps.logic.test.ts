// WHIT-274 — adversarial GAP tests for the flag-OFF restore SEED in src/auth.ts
// (refreshFromStoredToken seeds session.refreshToken after resaveUnguarded, ~line 735).
// Complements the [G5] pin in authRestoreResaveGaps.logic.test.ts (which covers the OAuth,
// NON-rotating flag-off reuse) with the surfaces [G5] cannot reach from its harness:
//   [G6] the SRP / InitiateAuth refresh surface — [G5] only mocks the OAuth refreshAsync,
//        so it never proves the seed also spares the InitiateAuth (fetch) path a second
//        keychain read + resave. refreshTokens() routes on the stored auth method, so an
//        SRP session takes a DIFFERENT production code path (refreshViaInitiateAuth) whose
//        own cacheToken must preserve the seeded token across the hourly refresh.
//   [G7] a ROTATING flag-off restore, then a SECOND refresh — the seed plants the OLD 'R';
//        the rotation's cacheToken must OVERWRITE memory with 'R2' so the next refresh
//        redeems the ROTATED token, not the stale seeded one (the card's flagged risk:
//        "seeding a stale token a rotating refresh should replace"). No second keychain read.
// Deliberately NOT written (weighed and dropped):
//   - a THIRD consecutive non-rotating refresh ("no drift"): the memory-preservation
//     invariant is already crossed once inside [G5]/[G6]; a third crossing is near-zero
//     added signal for the cost.
//   - "seed cleared on logout": signOut()'s FIRST statement is clearSession() (auth.ts:775
//     → 180, session=null), and signIn ALREADY seeds session.refreshToken via cacheToken, so
//     "a session's in-memory refresh token is dropped on logout" is a pre-existing invariant
//     covered by auth.logic.test.ts's signOut suite — the seed adds no new leak surface.
// Same mock harness shape as authPasswordEdges.logic.test.ts (adds the fetch + pool-id setup
// the InitiateAuth path needs) and authRestoreResaveGaps.logic.test.ts.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockRefresh = jest.fn<(...a: unknown[]) => Promise<unknown>>();
jest.mock('expo-auth-session', () => ({
  makeRedirectUri: () => 'acme://oauthredirect',
  ResponseType: { Code: 'code' },
  AuthRequest: class {
    codeVerifier = 'verifier';
    promptAsync = jest.fn();
  },
  exchangeCodeAsync: jest.fn(),
  refreshAsync: (...a: unknown[]) => mockRefresh(...a),
}));

const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
const mockSetItem = jest.fn<(key: string, val: string, opts?: unknown) => Promise<void>>(async () => {});
const mockDeleteItem = jest.fn<(key: string) => Promise<void>>(async () => {});
const mockCanUseBiometric = jest.fn<() => boolean>(() => false);
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => mockGetItem(...(a as [string, unknown])),
  setItemAsync: (...a: unknown[]) => mockSetItem(...(a as [string, string, unknown])),
  deleteItemAsync: (...a: unknown[]) => mockDeleteItem(...(a as [string])),
  canUseBiometricAuthentication: () => mockCanUseBiometric(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

let mockPlatformOS: string = 'ios';
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mockPlatformOS;
    },
  },
}));

const REFRESH_KEY = 'whittle.cognito.refreshToken';
const METHOD_KEY = 'whittle.cognito.authMethod';
const DOMAIN = 'https://whittle-auth.auth.ap-southeast-2.amazoncognito.com';
const POOL_ID = 'ap-southeast-2_pool123';
const nowSec = () => Math.floor(Date.now() / 1000);
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const loadAuth = (): typeof import('../auth') => require('../auth');

let mockFetch: ReturnType<typeof jest.fn>;

function refreshReads() {
  return mockGetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function refreshTokenWrites() {
  return mockSetItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}
function refreshTokenDeletes() {
  return mockDeleteItem.mock.calls.filter((c) => c[0] === REFRESH_KEY);
}

beforeEach(() => {
  jest.resetModules();
  mockPlatformOS = 'ios';
  mockRefresh.mockReset();
  mockGetItem.mockReset().mockResolvedValue(null);
  mockSetItem.mockReset().mockResolvedValue(undefined);
  mockDeleteItem.mockReset().mockResolvedValue(undefined);
  mockCanUseBiometric.mockReset().mockReturnValue(false);
  mockFetch = jest.fn<(url: string, init?: { body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
  (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
  process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN = DOMAIN;
  process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID = 'client123';
  process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID = POOL_ID;
});
afterEach(() => {
  delete process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
  delete process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
  delete process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
  delete process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED;
});

// [G6] The seed on the SRP / InitiateAuth surface. The stored auth method is 'srp', so the
// cold restore refreshes via refreshViaInitiateAuth (fetch), NOT the OAuth grant [G5] mocks.
// The first InitiateAuth response is deliberately short-lived (ExpiresIn 30s < the 60s skew)
// so the id token is born already near-expiry and the SECOND getAuthToken forces a genuine
// second refresh. The seed must let that second refresh reuse the in-memory 'R': no second
// keychain read of the refresh token, no second resave (delete+create), and the InitiateAuth
// body must carry the reused 'R'. Fail-on-revert: drop the `session = {…}` seed at auth.ts
// ~735 → the second refreshFromStoredToken re-enters the keychain-read branch → reads==2,
// deletes==2, writes==2 → every count assertion below fails.
describe('WHIT-274 — the seed spares the SRP / InitiateAuth path a second read + resave', () => {
  it('a second InitiateAuth refresh reuses the in-memory token; keychain touched once', async () => {
    mockGetItem.mockImplementation(async (k) => {
      if (k === REFRESH_KEY) return 'R';
      if (k === METHOD_KEY) return 'srp'; // cold-launch provenance → InitiateAuth refresh
      return null;
    });
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID1', AccessToken: 'A', ExpiresIn: 30 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ AuthenticationResult: { IdToken: 'ID2', AccessToken: 'A2', ExpiresIn: 3600 } }) });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');

    // The short-lived first token forces a real second swap through InitiateAuth.
    await expect(auth.getAuthToken()).resolves.toBe('ID2');

    expect(refreshReads()).toHaveLength(1);        // keychain read only on the first restore
    expect(refreshTokenDeletes()).toHaveLength(1); // only the first restore's resave delete
    expect(refreshTokenWrites()).toHaveLength(1);  // only the first restore's resave create
    expect(mockFetch).toHaveBeenCalledTimes(2);    // two genuine InitiateAuth refreshes
    // The second refresh redeemed the reused in-memory token, not a fresh keychain read.
    const body = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body) as {
      AuthParameters: { REFRESH_TOKEN: string };
    };
    expect(body.AuthParameters.REFRESH_TOKEN).toBe('R');
  });
});

// [G7] A ROTATING flag-off restore, then the hourly refresh. The seed plants the OLD token
// 'R' in memory BEFORE the refresh; the rotation returns 'R2', and cacheToken's
// `token.refreshToken ?? session?.refreshToken` must OVERWRITE the seed so the NEXT refresh
// redeems 'R2', never the stale seeded 'R'. This is the card's flagged risk. The second
// refresh must also reuse memory — no second keychain read. NOTE its fail-on-revert target
// is cacheToken's rotation preference (flip it to `session?.refreshToken ?? token.refreshToken`
// → the second refresh redeems 'R' → the 'R2' assertion fails), NOT the seed line: on a
// rotating restore the rotation's own cacheToken re-seeds memory even without the [G6]/[G5]
// seed, so reads==1 holds either way here — stated honestly.
describe('WHIT-274 — a rotating restore replaces the seeded token; next refresh uses the rotated one', () => {
  it('the second refresh redeems R2 (not the stale seeded R) with no extra keychain read', async () => {
    mockGetItem.mockImplementation(async (k) => (k === REFRESH_KEY ? 'R' : null)); // method null → OAuth
    mockRefresh
      // First (restore) refresh ROTATES to R2 and hands back a near-expiry id token so the
      // second getAuthToken must refresh again.
      .mockResolvedValueOnce({ idToken: 'ID1', accessToken: 'A', refreshToken: 'R2', issuedAt: nowSec() - 4000, expiresIn: 3600 })
      // Second refresh is non-rotating and fresh.
      .mockResolvedValueOnce({ idToken: 'ID2', accessToken: 'A2', issuedAt: nowSec(), expiresIn: 3600 });
    const auth = loadAuth();

    await expect(auth.restoreSession()).resolves.toBe(true);
    expect(auth.getStatus()).toBe('authed');
    expect(refreshReads()).toHaveLength(1);

    await expect(auth.getAuthToken()).resolves.toBe('ID2');

    expect(refreshReads()).toHaveLength(1); // still one — the rotated token lives in memory
    // The stale seeded 'R' was replaced: the second refresh redeems the ROTATED 'R2'.
    expect((mockRefresh.mock.calls[1][0] as { refreshToken: string }).refreshToken).toBe('R2');
  });
});
