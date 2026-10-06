// WHIT-786 — shared setup for the suites that test src/auth.ts itself: the saved-login key names,
// the clock, a fresh-module loader, a fake Cognito session, and builders for the native-module
// mocks (keychain, Hosted UI, Cognito SDK). Usage in a suite:
//
//   const mockGetItem = jest.fn<(key: string, opts?: unknown) => Promise<string | null>>();
//   jest.mock('expo-secure-store', () => require('./support/authModule').secureStoreMock({ getItem: mockGetItem }));
//   import { REFRESH_KEY, loadAuth, nowSec } from './support/authModule';
//
// Stateless on purpose: these suites call jest.resetModules() before each test, which reloads
// this file too, so every spy lives as a top-level `mock*` jest.fn in the suite and is passed in.
import { jest } from '@jest/globals';

export const REFRESH_KEY = 'abundo.cognito.refreshToken';
export const SENTINEL_KEY = 'abundo.cognito.hasSession';
export const METHOD_KEY = 'abundo.cognito.authMethod';

export const nowSec = (): number => Math.floor(Date.now() / 1000);

// A fresh src/auth each call, so its in-memory session/status singletons don't leak between tests.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
export const loadAuth = (): typeof import('../../auth') => require('../../auth');

/** A stand-in CognitoUserSession with the getters seatCognitoSession reads. */
export function fakeSession(
  idJwt = 'IDTOK',
  accessJwt = 'AC',
  claims: unknown = { iat: nowSec(), exp: nowSec() + 3600 },
  refresh = 'R',
) {
  return {
    getIdToken: () => ({ getJwtToken: () => idJwt, decodePayload: () => claims }),
    getAccessToken: () => ({ getJwtToken: () => accessJwt }),
    getRefreshToken: () => ({ getToken: () => refresh }),
  };
}

type SecureStoreFakes = {
  getItem?: (key: string, opts?: unknown) => Promise<string | null>;
  setItem?: (key: string, value: string, opts?: unknown) => Promise<void>;
  deleteItem?: (key: string, opts?: unknown) => Promise<void>;
  canUseBiometric?: () => boolean;
};

export function secureStoreMock({
  getItem = async () => null,
  setItem = async () => {},
  deleteItem = async () => {},
  canUseBiometric = () => false,
}: SecureStoreFakes = {}) {
  return {
    getItemAsync: getItem,
    setItemAsync: setItem,
    deleteItemAsync: deleteItem,
    canUseBiometricAuthentication: canUseBiometric,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  };
}

/** A keychain backed by the suite's own Map, so tests can seed and inspect it directly. */
export function memorySecureStoreMock(store: Map<string, string>) {
  return secureStoreMock({
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    deleteItem: async (key) => {
      store.delete(key);
    },
  });
}

type AuthSessionFakes = {
  promptAsync?: () => Promise<unknown>;
  exchange?: (...a: unknown[]) => unknown;
  refresh?: (...a: unknown[]) => unknown;
  onAuthRequest?: (cfg: unknown) => void;
  overrides?: Record<string, unknown>;
};

export function authSessionMock({
  promptAsync,
  exchange = jest.fn(),
  refresh = jest.fn(),
  onAuthRequest,
  overrides,
}: AuthSessionFakes = {}) {
  return {
    makeRedirectUri: () => 'acme://oauthredirect',
    ResponseType: { Code: 'code' },
    AuthRequest: class {
      codeVerifier = 'verifier';
      promptAsync = promptAsync;
      constructor(cfg: unknown) {
        onAuthRequest?.(cfg);
      }
    },
    exchangeCodeAsync: exchange,
    refreshAsync: refresh,
    ...overrides,
  };
}

type CognitoFakes = {
  authenticateUser: (details: unknown, callbacks: Record<string, (arg?: unknown) => void>) => void;
  completeNewPasswordChallenge?: (
    password: string,
    attributes: unknown,
    callbacks: Record<string, (arg?: unknown) => void>,
  ) => void;
  onAuthDetails?: (cfg: unknown) => void;
  decodePayload?: () => Record<string, string | undefined>;
};

export function cognitoMock({
  authenticateUser,
  completeNewPasswordChallenge,
  onAuthDetails,
  decodePayload,
}: CognitoFakes) {
  const sdk: Record<string, unknown> = {
    CognitoUserPool: class {},
    AuthenticationDetails: class {
      constructor(cfg: unknown) {
        onAuthDetails?.(cfg);
      }
    },
    CognitoUser: class {
      authenticateUser = authenticateUser;
      completeNewPasswordChallenge = completeNewPasswordChallenge;
    },
  };
  if (!decodePayload) return sdk;
  // getCurrentUser decodes the raw id token through this.
  sdk.CognitoIdToken = class {
    decodePayload = decodePayload;
  };
  return sdk;
}
