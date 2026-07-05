// Cognito Hosted UI sign-in (WHIT-160) — auth epic card 2 of 4.
//
// Runs the real authorization-code + PKCE flow against the Cognito Hosted UI
// (Google/Apple federated), stores the refresh token in SecureStore, keeps the
// id/access token in memory, and refreshes silently. Best-effort / never-throw,
// mirroring src/push.ts: a failure resolves to "not signed in", never a crash.
//
// SHIPS DARK: this module is fully wired and tested, but src/api.ts only sends a
// Cognito token when EXPO_PUBLIC_AUTH_USE_COGNITO === 'true' (default off). The
// JWT authorizer WHIT-97 added is attached to NO route yet (route cutover is
// WHIT-162), so every route is still gated by the shared secret — sending a
// Cognito token today would 403. Until WHIT-162, the flag stays off and the app
// keeps using the static secret.
//
// NODE-SAFE ON IMPORT: no native module or react-native is imported at the top
// level (only `import type`), and there is no module-top side effect. Native
// modules are lazy-`require`d inside the functions that use them, so the `logic`
// jest project (node env, no native mocks) can import this file without crashing.

// Types only — erased at compile, so nothing native loads on import.
import type { DiscoveryDocument, TokenResponse } from "expo-auth-session";

/** Where the returning-user auth state can be, from the gate's point of view. */
export type AuthStatus = "loading" | "authed" | "anon";

/** The in-memory token set. `issuedAt`/`expiresIn` are seconds (OAuth convention). */
interface Session {
  idToken: string | undefined;
  accessToken: string;
  issuedAt: number;
  expiresIn: number;
}

// SecureStore key for the long-lived refresh token. Single-user, so one fixed key.
const REFRESH_TOKEN_KEY = "whittle.cognito.refreshToken";
// Refresh this many seconds BEFORE the id token actually expires, to absorb clock
// skew / in-flight latency (a device clock a little fast must not send a token the
// API already considers expired).
const EXPIRY_SKEW_SECONDS = 60;

// Module singletons. `session` is the live token set (null = not signed in).
let session: Session | null = null;
let status: AuthStatus = "loading";
// Single-flight: concurrent getAuthToken() callers whose token is stale share ONE
// refresh (AppProvider fires ~9 data fetches on mount — without this they would
// each fire their own refreshAsync and race to overwrite the cache).
let refreshInFlight: Promise<string | undefined> | null = null;
const listeners = new Set<() => void>();

/** Current gate status, read synchronously by the auth hook's initial render. */
export function getStatus(): AuthStatus {
  return status;
}

/** Subscribe to auth-status changes; returns an unsubscribe fn. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setStatus(next: AuthStatus): void {
  if (next === status) return;
  status = next;
  listeners.forEach((l) => l());
}

// --- config (read at call time, like src/api.ts apiToken, so exports are inlined
// at build and tests can set them per-case) --------------------------------------

function hostedUiDomain(): string | undefined {
  return process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
}

function appClientId(): string | undefined {
  return process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
}

// The OAuth endpoints all live on the Hosted UI domain (…amazoncognito.com), NOT
// the issuer host (cognito-idp…). Built manually rather than via useAutoDiscovery
// because Cognito does not serve a discovery doc on the Hosted UI domain.
function discovery(domain: string): DiscoveryDocument {
  return {
    authorizationEndpoint: `${domain}/oauth2/authorize`,
    tokenEndpoint: `${domain}/oauth2/token`,
    revocationEndpoint: `${domain}/oauth2/revoke`,
    endSessionEndpoint: `${domain}/logout`,
  };
}

function cacheToken(token: Pick<TokenResponse, "idToken" | "accessToken" | "issuedAt" | "expiresIn">): void {
  session = {
    idToken: token.idToken,
    accessToken: token.accessToken,
    issuedAt: token.issuedAt,
    expiresIn: token.expiresIn ?? 0,
  };
}

function clearSession(): void {
  session = null;
  setStatus("anon");
}

function isNearExpiry(s: Session): boolean {
  // Unknown lifetime → treat as stale so we refresh rather than send a token that
  // might already be expired.
  if (!s.expiresIn) return true;
  const expiresAt = s.issuedAt + s.expiresIn;
  return Date.now() / 1000 >= expiresAt - EXPIRY_SKEW_SECONDS;
}

/**
 * Run the Hosted UI sign-in: open the browser, exchange the code (with the PKCE
 * verifier) for tokens, persist the refresh token. Returns whether a session was
 * established. Never throws — a cancel, a network error, or missing config all
 * resolve to `false`.
 */
export async function signIn(): Promise<boolean> {
  try {
    const domain = hostedUiDomain();
    const clientId = appClientId();
    if (!domain || !clientId) return false;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AuthSession = require("expo-auth-session");
    const redirectUri = AuthSession.makeRedirectUri({ scheme: "acme", path: "oauthredirect" });
    const disco = discovery(domain);

    const request = new AuthSession.AuthRequest({
      clientId,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      scopes: ["openid", "email", "profile"],
      usePKCE: true,
    });

    const result = await request.promptAsync(disco);
    if (result.type !== "success" || !result.params?.code) return false;

    const token: TokenResponse = await AuthSession.exchangeCodeAsync(
      {
        clientId,
        code: result.params.code,
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier ?? "" },
      },
      disco,
    );

    // Persist the refresh token BEFORE caching in memory, so a keychain write
    // failure leaves us cleanly signed-out (returns false) rather than "signed in"
    // in memory with nothing durable to restore from.
    if (token.refreshToken) await setRefreshToken(token.refreshToken);
    cacheToken(token);
    setStatus("authed");
    return true;
  } catch {
    // User cancel, network, popup dismissed — stay signed-out, never crash.
    return false;
  }
}

/**
 * Return a valid Cognito **ID token** (the token the WHIT-97 JWT authorizer
 * accepts — its `aud` is the app client id; access tokens carry `client_id`, not
 * `aud`, and would be rejected). Returns the cached id token when fresh; otherwise
 * refreshes once from the stored refresh token (single-flight). `undefined` when
 * there is no session or the refresh fails — callers fall back to the static
 * secret.
 */
export async function getAuthToken(): Promise<string | undefined> {
  if (session?.idToken && !isNearExpiry(session)) return session.idToken;
  if (!refreshInFlight) {
    refreshInFlight = refreshFromStoredToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function refreshFromStoredToken(): Promise<string | undefined> {
  try {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      clearSession();
      return undefined;
    }
    const domain = hostedUiDomain();
    const clientId = appClientId();
    if (!domain || !clientId) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AuthSession = require("expo-auth-session");
    const token: TokenResponse = await AuthSession.refreshAsync(
      { clientId, refreshToken },
      { tokenEndpoint: `${domain}/oauth2/token` },
    );

    cacheToken(token);
    // Cognito omits the refresh token on refresh (the existing one stays valid);
    // only overwrite when a rotated one is actually returned.
    if (token.refreshToken) await setRefreshToken(token.refreshToken);
    setStatus("authed");
    return token.idToken;
  } catch {
    clearSession();
    return undefined;
  }
}

/**
 * On launch, try to re-establish a session from the stored refresh token (silent
 * refresh). Resolves to whether a valid session now exists, and moves the gate
 * status to `authed` / `anon`. Never throws.
 */
export async function restoreSession(): Promise<boolean> {
  const idToken = await getAuthToken();
  if (idToken) {
    setStatus("authed");
    return true;
  }
  setStatus("anon");
  return false;
}

/**
 * Sign out: drop the stored refresh token + in-memory session, and best-effort
 * clear the Hosted UI cookie via the Cognito logout endpoint (logout_uri is the
 * `acme://signout` callback registered in terraform — a different path from the
 * login redirect). Never throws.
 */
export async function signOut(): Promise<void> {
  // Drop the local session FIRST, so a keychain or browser failure below can never
  // leave the user "signed in" in memory with a live token.
  clearSession();
  try {
    await deleteRefreshToken();
    const domain = hostedUiDomain();
    const clientId = appClientId();
    if (!domain || !clientId) return;
    const logoutRedirect = "acme://signout";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebBrowser = require("expo-web-browser");
    await WebBrowser.openAuthSessionAsync(
      `${domain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(logoutRedirect)}`,
      logoutRedirect,
    );
  } catch {
    // Best-effort — the local session is already cleared above.
  }
}

// --- SecureStore wrappers (lazy require; web/simulator throw is swallowed) --------

async function setRefreshToken(value: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, value);
}

async function getRefreshToken(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

async function deleteRefreshToken(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

// --- gate decision (pure — the fail-on-revert-testable core of the auth gate) -----

/**
 * Decide where the auth gate should send the user, or `null` to render normally.
 * Pure so it can be unit-tested exhaustively in the node `logic` project.
 *
 * - Gate off, still loading, or the navigator not yet mounted → null (no redirect).
 * - `anon` trying to reach a protected (tabs) route → back to the login screen.
 * - `authed` sitting on the login screen → forward to the app.
 */
export function gateRedirect(opts: {
  enabled: boolean;
  navReady: boolean;
  status: AuthStatus;
  onIndex: boolean;
}): "/" | "/(tabs)/budgets" | null {
  if (!opts.enabled || !opts.navReady || opts.status === "loading") return null;
  if (opts.status === "anon" && !opts.onIndex) return "/";
  if (opts.status === "authed" && opts.onIndex) return "/(tabs)/budgets";
  return null;
}
