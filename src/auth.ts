// Cognito Hosted UI sign-in (WHIT-160) — auth epic card 2 of 4.
//
// Runs the real authorization-code + PKCE flow against the Cognito Hosted UI
// (Google/Apple federated), stores the refresh token in SecureStore, keeps the
// id/access token in memory, and refreshes silently. Best-effort / never-throw,
// mirroring src/push.ts: a failure resolves to "not signed in", never a crash.
//
// LIVE AUTH (WHIT-162): the static secret is retired — src/api.ts authenticates
// every request with the Cognito ID token this module provides (getAuthToken), and
// all API Gateway routes are guarded by the Cognito JWT authorizer. There is no
// static fallback: with no session, an API call fails "Not signed in" and the auth
// gate forces login.
//
// NODE-SAFE ON IMPORT: no native module or react-native is imported at the top
// level (only `import type`), and there is no module-top side effect. Native
// modules are lazy-`require`d inside the functions that use them, so the `logic`
// jest project (node env, no native mocks) can import this file without crashing.
//
// WHIT-161 (Face ID): when EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED === 'true' AND the
// device supports biometrics, the refresh token is stored in a biometric-locked
// keychain item (`requireAuthentication`) — reading it pops Face ID / Touch ID,
// which IS the unlock. The token is then cached in memory for the session so
// hourly refreshes never re-prompt; the app re-locks (drops the cache, re-reads)
// on resume. Also ships dark (default off); a device with no biometrics stores
// unguarded and never locks out.

// Types only — erased at compile, so nothing native loads on import.
import type { DiscoveryDocument, TokenResponse } from "expo-auth-session";
// Type-only (erased): the SDK itself is lazy-`require`d inside signInWithPassword so
// the node `logic` jest project can still import this module. WHIT-178.
import type { CognitoUser, CognitoUserSession } from "amazon-cognito-identity-js";

/**
 * Where the returning-user auth state can be, from the gate's point of view.
 * `locked` (WHIT-161) = a session exists but is sealed behind biometrics until
 * the user passes Face ID / Touch ID.
 */
export type AuthStatus = "loading" | "authed" | "anon" | "locked";

/**
 * Result of a native email/password sign-in (WHIT-178). `challenge` surfaces
 * Cognito's NEW_PASSWORD_REQUIRED (an admin-created user's first login) for WHIT-181
 * to complete; `error` is a friendly, user-facing message. Never a thrown exception.
 */
export type SignInResult =
  | { ok: true }
  | { ok: false; challenge: "NEW_PASSWORD_REQUIRED" }
  | { ok: false; error: string };

/**
 * Result of completing the NEW_PASSWORD_REQUIRED challenge (WHIT-181). It is the
 * terminal step, so — unlike a fresh sign-in — it can never surface another challenge;
 * a narrower union than SignInResult (no `challenge` variant).
 */
export type CompletePasswordResult = { ok: true } | { ok: false; error: string };

/** The in-memory token set. `issuedAt`/`expiresIn` are seconds (OAuth convention). */
interface Session {
  idToken: string | undefined;
  accessToken: string;
  issuedAt: number;
  expiresIn: number;
  // Held in memory after the one-time biometric unlock so silent refreshes reuse
  // it instead of re-reading the guarded keychain (= re-prompting). Cognito omits
  // the refresh token on refresh, so it's preserved across refreshes.
  refreshToken: string | undefined;
}

// SecureStore key for the long-lived refresh token. Single-user, so one fixed key.
const REFRESH_TOKEN_KEY = "whittle.cognito.refreshToken";
// Unguarded marker written in lockstep with the refresh token, so the gate can
// tell "a session exists" WITHOUT reading the guarded token (which would pop Face
// ID blindly). Written AFTER the token, deleted with it. Flag-independent, so a
// session created while biometrics are off is still found when the flag flips on.
const SESSION_SENTINEL_KEY = "whittle.cognito.hasSession";
// WHIT-178: which surface minted the session — "srp" (native email/password via
// InitiateAuth) vs absent/"oauth" (Hosted UI / federated Google). The REFRESH path
// must match the mint surface: an SRP-minted refresh token isn't reliably redeemable
// at the OAuth /oauth2/token endpoint (it can come back with no id token), so SRP
// sessions refresh via InitiateAuth REFRESH_TOKEN_AUTH. Unguarded like the sentinel
// (not secret); read on cold launch. Absent = a pre-WHIT-178 OAuth session.
const AUTH_METHOD_KEY = "whittle.cognito.authMethod";
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
// Single-flight for the biometric unlock, so overlapping unlock() calls share one
// guarded read (= one Face ID prompt) instead of stacking prompts.
let unlockInFlight: Promise<boolean> | null = null;
// WHIT-178: single-flight for native password sign-in, so a double-tap can't spawn
// two authenticate attempts racing on the seated session / the challenge singleton.
let signInInFlight: Promise<SignInResult> | null = null;
// WHIT-181: single-flight for completing the NEW_PASSWORD_REQUIRED challenge.
let completeInFlight: Promise<CompletePasswordResult> | null = null;
// WHIT-178: the CognitoUser mid-NEW_PASSWORD_REQUIRED challenge, stashed so WHIT-181
// can complete it against the SAME attempt. Reset at the start of every attempt (so a
// stale one never lingers) and only set when the challenge fires. --- WHIT-181 SEAM ---
let pendingChallengeUser: CognitoUser | null = null;
// WHIT-178: the live session's mint surface, cached in memory so an hourly refresh
// routes to the right endpoint even if the unguarded method-key read transiently
// fails; a cold launch (null) falls back to the stored value. Set on seat / signIn,
// cleared on clearSession.
let sessionAuthMethod: "srp" | "oauth" | null = null;
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

// --- config (read at CALL time, not captured at module load, so the Expo bundler's
// inlined EXPO_PUBLIC_* values resolve correctly and tests can set them per-case) --

function hostedUiDomain(): string | undefined {
  return process.env.EXPO_PUBLIC_COGNITO_HOSTED_UI_DOMAIN;
}

function appClientId(): string | undefined {
  return process.env.EXPO_PUBLIC_COGNITO_APP_CLIENT_ID;
}

// WHIT-178: the User Pool id (e.g. `ap-southeast-2_xxxx`), needed by the Cognito SDK
// for native sign-in and by the InitiateAuth refresh. The SDK derives the AWS region
// from the `<region>_...` prefix, so no separate region var is needed.
function userPoolId(): string | undefined {
  return process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID;
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

function cacheToken(
  token: Pick<TokenResponse, "idToken" | "accessToken" | "issuedAt" | "expiresIn" | "refreshToken">,
): void {
  session = {
    idToken: token.idToken,
    accessToken: token.accessToken,
    issuedAt: token.issuedAt,
    expiresIn: token.expiresIn ?? 0,
    // Keep the refresh token in memory: a refresh response omits it (Cognito reuses
    // the existing one), so fall back to the one already cached rather than losing it.
    refreshToken: token.refreshToken ?? session?.refreshToken,
  };
}

function clearSession(): void {
  session = null;
  sessionAuthMethod = null;
  setStatus("anon");
}

// Biometric lock is active only when the flag is on AND the device can actually
// store/read a value behind biometrics. Exposed for the gate's launch decision.
export function canBiometricLock(): boolean {
  if (process.env.EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED !== "true") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require("expo-secure-store");
    return SecureStore.canUseBiometricAuthentication() === true;
  } catch {
    return false;
  }
}

// The SecureStore options that guard the refresh token behind biometrics. Returns
// the guarded options only when biometric locking is active; otherwise `{}` (an
// unguarded item, byte-compatible with WHIT-160 storage) so a device without
// biometrics is never locked out.
function secureOpts(): Record<string, unknown> {
  if (!canBiometricLock()) return {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  return {
    requireAuthentication: true,
    authenticationPrompt: "Unlock Whittle",
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
}

function isNearExpiry(s: Session): boolean {
  // Unknown lifetime → treat as stale so we refresh rather than send a token that
  // might already be expired.
  if (!s.expiresIn) return true;
  const expiresAt = s.issuedAt + s.expiresIn;
  return Date.now() / 1000 >= expiresAt - EXPIRY_SKEW_SECONDS;
}

/**
 * Run the Hosted UI authorization-code + PKCE flow: open the browser, exchange the
 * code (with the PKCE verifier) for tokens, persist the refresh token, and seat the
 * session as an OAuth session. `extraParams` are appended to the /oauth2/authorize
 * request — e.g. `{ identity_provider: "Google" }` makes Cognito redirect STRAIGHT to
 * Google, skipping its chooser page (WHIT-179). Returns whether a session was
 * established. Never throws — a cancel, a network error, or missing config all
 * resolve to `false`.
 */
async function hostedUiAuthorize(extraParams?: Record<string, string>): Promise<boolean> {
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
      ...(extraParams ? { extraParams } : {}),
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

    // Persist the refresh token BEFORE caching in memory, so a keychain write failure
    // leaves us cleanly signed-out (returns false). Order: token → provenance →
    // sentinel (the "session ready" marker, written last). WHIT-178: record "oauth" so
    // the freshest mint overwrites any stale "srp" and the OAuth session refreshes via
    // /oauth2/token, not InitiateAuth.
    if (token.refreshToken) {
      await setRefreshToken(token.refreshToken);
      await setAuthMethod("oauth");
      await setSessionSentinel();
    }
    sessionAuthMethod = "oauth";
    cacheToken(token);
    setStatus("authed");
    return true;
  } catch {
    // User cancel, network, popup dismissed — stay signed-out, never crash.
    return false;
  }
}

/**
 * Hosted UI sign-in showing the full chooser (Cognito login + any federated IdPs).
 * KEPT so the current login screen keeps working; WHIT-180 replaces it with the
 * native form + signInWithGoogle. Never throws.
 */
export async function signIn(): Promise<boolean> {
  return hostedUiAuthorize();
}

/**
 * Sign in with Google (WHIT-179): the same Hosted UI PKCE flow, but with
 * `identity_provider=Google` so Cognito redirects STRAIGHT to Google's own consent
 * sheet — the user never sees the Cognito chooser page. Federated → provenance
 * "oauth" (refreshes at /oauth2/token). The Pre-Sign-Up allowlist still gates which
 * Google accounts may sign up. Never throws.
 */
export async function signInWithGoogle(): Promise<boolean> {
  return hostedUiAuthorize({ identity_provider: "Google" });
}

/**
 * The signed-in user's identity, decoded from the cached ID token (WHIT-180). `email`
 * is always present; `name`/`picture` come from federated (Google) logins. Returns
 * null when signed out. Synchronous and non-reactive — read at render; the identity
 * doesn't change within a session. Uses the SDK's decoder (lazy-required) for robust
 * base64url + UTF-8 handling.
 */
export function getCurrentUser(): { email?: string; name?: string; picture?: string } | null {
  const jwt = session?.idToken;
  if (!jwt) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CognitoIdToken } = require("amazon-cognito-identity-js");
    const claims = new CognitoIdToken({ IdToken: jwt }).decodePayload() as Record<string, unknown>;
    // Coerce to string | undefined — a malformed token must never push a non-string
    // claim into the profile <Text>/initials. `email` is normally present, but that's
    // a token guarantee, not a code one, so callers degrade gracefully.
    const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
    return { email: str(claims.email), name: str(claims.name), picture: str(claims.picture) };
  } catch {
    return null;
  }
}

// If Cognito ever returns a challenge the app doesn't implement (the pool has no MFA
// today), the SDK would invoke an undefined callback and throw outside our promise —
// so we handle every challenge and resolve to this rather than break the never-throw
// contract. WHIT-178.
const UNSUPPORTED_CHALLENGE = "This account needs a sign-in step the app doesn't support yet.";

/**
 * Native email/password sign-in (WHIT-178) via the Cognito SDK's SRP flow — no Hosted
 * UI, and the password never leaves the device in the clear. On success the session
 * is seated through the SAME machinery as the Hosted UI path (refresh token
 * persisted, sentinel written, status → 'authed'), so Face ID + refresh keep working.
 * Surfaces NEW_PASSWORD_REQUIRED (an admin-created user's first login) for WHIT-181.
 * Never throws — bad credentials, a challenge, or offline all resolve to a result.
 * Single-flight so a double-tap can't stack two attempts.
 */
export function signInWithPassword(email: string, password: string): Promise<SignInResult> {
  if (!signInInFlight) {
    signInInFlight = runPasswordSignIn(email, password).finally(() => {
      signInInFlight = null;
    });
  }
  return signInInFlight;
}

async function runPasswordSignIn(email: string, password: string): Promise<SignInResult> {
  const clientId = appClientId();
  const poolId = userPoolId();
  if (!clientId || !poolId) {
    return { ok: false, error: "Sign-in isn't set up. Check the app configuration." };
  }
  pendingChallengeUser = null; // clear any stale challenge from a prior attempt
  // Normalise the email: trim stray whitespace and lower-case it (Cognito email
  // usernames are case-insensitive) so a valid user isn't rejected over casing/spaces.
  const username = email.trim().toLowerCase();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Cognito = require("amazon-cognito-identity-js");
    const pool = new Cognito.CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
    const user: CognitoUser = new Cognito.CognitoUser({ Username: username, Pool: pool });
    const details = new Cognito.AuthenticationDetails({ Username: username, Password: password });
    return await new Promise<SignInResult>((resolve) => {
      user.authenticateUser(details, {
        onSuccess: (cognitoSession: CognitoUserSession) => {
          seatCognitoSession(cognitoSession)
            .then(() => resolve({ ok: true }))
            .catch(async () => {
              // A partial seat (e.g. a keychain write threw) must NOT leave a durable
              // "zombie" session that mis-restores next launch — roll back any writes
              // before reporting failure. WHIT-178.
              clearSession();
              await clearStoredSession().catch(() => {});
              resolve({ ok: false, error: "Couldn't finish signing in. Try again." });
            });
        },
        onFailure: (err: unknown) => resolve({ ok: false, error: mapCognitoError(err) }),
        newPasswordRequired: () => {
          pendingChallengeUser = user; // WHIT-181 completes it against this attempt
          resolve({ ok: false, challenge: "NEW_PASSWORD_REQUIRED" });
        },
        // The pool has no MFA today; handle the rest defensively so an unexpected
        // challenge can't call an undefined callback and throw past us.
        mfaRequired: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
        totpRequired: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
        customChallenge: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
        mfaSetup: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
        selectMFAType: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
      });
    });
  } catch (err) {
    // A synchronous SDK throw (misconfig, missing crypto polyfill) → friendly result.
    return { ok: false, error: mapCognitoError(err) };
  }
}

// Seat a Cognito SDK session into the in-memory + persisted machinery, exactly like
// the Hosted UI path (signIn, above): refresh token FIRST, then the sentinel (the
// "token before sentinel" landmine), record the SRP auth method (so refresh uses the
// matching surface), cache the tokens, go 'authed'. WHIT-178.
async function seatCognitoSession(cognitoSession: CognitoUserSession): Promise<void> {
  const idToken = cognitoSession.getIdToken().getJwtToken();
  const accessToken = cognitoSession.getAccessToken().getJwtToken();
  // decodePayload() gives ABSOLUTE iat/exp; cacheToken/isNearExpiry want issuedAt
  // (absolute) + expiresIn (a DURATION), so pass exp - iat — NOT exp. Guard missing
  // claims so a malformed token can't make expiresIn NaN (which reads as "always
  // stale" and would bounce the user one frame after a "successful" sign-in).
  const claims = cognitoSession.getIdToken().decodePayload() as { iat?: number; exp?: number };
  const nowS = Math.floor(Date.now() / 1000);
  const iat = typeof claims.iat === "number" ? claims.iat : nowS;
  const exp = typeof claims.exp === "number" ? claims.exp : iat + 3600;
  const refreshToken = cognitoSession.getRefreshToken().getToken();
  // Order: token → provenance → sentinel. The sentinel is the "session ready" marker,
  // written LAST — so a mid-seat write failure never leaves a restorable session with
  // no provenance. (A throw here rejects up to onSuccess, which rolls back.)
  await setRefreshToken(refreshToken);
  await setAuthMethod("srp");
  await setSessionSentinel();
  sessionAuthMethod = "srp";
  cacheToken({ idToken, accessToken, issuedAt: iat, expiresIn: exp - iat, refreshToken });
  setStatus("authed");
}

// Map a Cognito SDK error to a friendly string. UserNotFound and NotAuthorized map to
// the SAME message so the UI never reveals whether an email is registered (paired
// with prevent_user_existence_errors on the client). WHIT-178.
function mapCognitoError(err: unknown): string {
  const e = (err ?? {}) as { code?: string; name?: string; message?: string };
  const code = e.code ?? e.name ?? "";
  const message = e.message ?? "";
  if (code === "NotAuthorizedException" && /attempts exceeded/i.test(message)) {
    return "Too many attempts. Try again in a bit.";
  }
  if (code === "NotAuthorizedException" || code === "UserNotFoundException") {
    return "Incorrect email or password.";
  }
  if (code === "TooManyRequestsException" || code === "LimitExceededException") {
    return "Too many attempts. Try again in a bit.";
  }
  if (code === "UserNotConfirmedException") return "Your account isn't verified yet.";
  if (code === "PasswordResetRequiredException") return "You need to reset your password.";
  if (code === "InvalidPasswordException") return "That password doesn't meet the requirements. Try a stronger one.";
  if (code === "CodeMismatchException") return "That code isn't right. Check it and try again.";
  if (code === "ExpiredCodeException") return "That code has expired. Request a new one.";
  if (!code || /network/i.test(code) || /network|timeout/i.test(message)) {
    return "You appear to be offline. Check your connection.";
  }
  return "Couldn't sign in. Try again.";
}

/**
 * Complete the NEW_PASSWORD_REQUIRED challenge (WHIT-181) that signInWithPassword
 * surfaced: set the user's real password against the SAME attempt
 * (`pendingChallengeUser`) and, on success, seat the session. A weak/invalid password
 * keeps the challenge alive so the user can retry; a missing/expired challenge → asks
 * them to sign in again. Never throws. Single-flight against a double-tap.
 */
export function completeNewPassword(newPassword: string): Promise<CompletePasswordResult> {
  if (!completeInFlight) {
    completeInFlight = runCompleteNewPassword(newPassword).finally(() => {
      completeInFlight = null;
    });
  }
  return completeInFlight;
}

async function runCompleteNewPassword(newPassword: string): Promise<CompletePasswordResult> {
  const user = pendingChallengeUser;
  if (!user) {
    return { ok: false, error: "Your sign-in expired. Please sign in again." };
  }
  try {
    return await new Promise<CompletePasswordResult>((resolve) => {
      user.completeNewPasswordChallenge(
        newPassword,
        {}, // no additional required attributes for the single-user pool
        {
          onSuccess: (cognitoSession: CognitoUserSession) => {
            pendingChallengeUser = null;
            seatCognitoSession(cognitoSession)
              .then(() => resolve({ ok: true }))
              .catch(async () => {
                // Mirror the WHIT-178 sign-in rollback: a partial seat must not leave
                // an orphaned refresh token in the keychain.
                clearSession();
                await clearStoredSession().catch(() => {});
                resolve({ ok: false, error: "Couldn't finish signing in. Try again." });
              });
          },
          // Keep pendingChallengeUser on failure (e.g. a too-weak password) so the user
          // can retry against the same challenge without signing in again.
          onFailure: (err: unknown) => resolve({ ok: false, error: mapCognitoError(err) }),
          mfaRequired: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
          totpRequired: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
          customChallenge: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
          mfaSetup: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
          selectMFAType: () => resolve({ ok: false, error: UNSUPPORTED_CHALLENGE }),
        },
      );
    });
  } catch (err) {
    return { ok: false, error: mapCognitoError(err) };
  }
}

/**
 * WHIT-182: request a password-reset code. Cognito emails a one-time code to the
 * account's verified email. Resolves ok whether the SDK reports the send via
 * `onSuccess` or `inputVerificationCode`. Stateless (a fresh CognitoUser); never throws.
 */
export async function requestPasswordReset(email: string): Promise<CompletePasswordResult> {
  const clientId = appClientId();
  const poolId = userPoolId();
  if (!clientId || !poolId) return { ok: false, error: "Sign-in isn't set up. Check the app configuration." };
  const username = email.trim().toLowerCase();
  if (!username) return { ok: false, error: "Enter your email first." };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Cognito = require("amazon-cognito-identity-js");
    const pool = new Cognito.CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
    const user: CognitoUser = new Cognito.CognitoUser({ Username: username, Pool: pool });
    return await new Promise<CompletePasswordResult>((resolve) => {
      user.forgotPassword({
        onSuccess: () => resolve({ ok: true }),
        inputVerificationCode: () => resolve({ ok: true }),
        onFailure: (err: unknown) => resolve({ ok: false, error: mapCognitoError(err) }),
      });
    });
  } catch (err) {
    return { ok: false, error: mapCognitoError(err) };
  }
}

/**
 * WHIT-182: confirm a password reset with the emailed code + a new password. On
 * success the user then signs in with the new password (this does NOT return tokens,
 * so it does not seat a session). Stateless; never throws.
 */
export async function confirmPasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<CompletePasswordResult> {
  const clientId = appClientId();
  const poolId = userPoolId();
  if (!clientId || !poolId) return { ok: false, error: "Sign-in isn't set up. Check the app configuration." };
  const username = email.trim().toLowerCase();
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Cognito = require("amazon-cognito-identity-js");
    const pool = new Cognito.CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
    const user: CognitoUser = new Cognito.CognitoUser({ Username: username, Pool: pool });
    return await new Promise<CompletePasswordResult>((resolve) => {
      user.confirmPassword(code.trim(), newPassword, {
        onSuccess: () => resolve({ ok: true }),
        onFailure: (err: unknown) => resolve({ ok: false, error: mapCognitoError(err) }),
      });
    });
  } catch (err) {
    return { ok: false, error: mapCognitoError(err) };
  }
}

/**
 * Return a valid Cognito **ID token** (the token the WHIT-97 JWT authorizer
 * accepts — its `aud` is the app client id; access tokens carry `client_id`, not
 * `aud`, and would be rejected). Returns the cached id token when fresh; otherwise
 * refreshes once from the stored refresh token (single-flight). `undefined` when
 * there is no session or the refresh fails — the caller (src/api.ts authHeaders)
 * then throws "Not signed in" (there is no static-secret fallback since WHIT-162).
 */
export async function getAuthToken(): Promise<string | undefined> {
  // Locked (WHIT-161): never read the biometric-guarded key here — that would pop
  // Face ID outside the lock-screen flow and, on success, silently reveal the app.
  // The dedicated unlock() path is the only place allowed to read while locked.
  if (status === "locked") return undefined;
  if (session?.idToken && !isNearExpiry(session)) return session.idToken;
  if (!refreshInFlight) {
    refreshInFlight = refreshFromStoredToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Core token refresh: swap the given refresh token for a fresh id token, updating the
// in-memory cache (and, if the token rotated, the guarded keychain). Returns the new
// id token, or undefined on any failure. Deliberately does NOT touch the gate status
// or clear the session — the CALLER owns the terminal status. That is what lets
// unlock() keep a failed OFFLINE refresh at 'locked' instead of the
// getAuthToken/restore path's clearSession() broadcasting a transient 'anon' (which
// flashed a login redirect for one frame before the lock screen painted). WHIT-171.
//
// WHIT-178: refresh on the surface that MINTED the session. SRP/native-password
// sessions go through InitiateAuth REFRESH_TOKEN_AUTH (their refresh token isn't
// reliably redeemable at the OAuth /oauth2/token endpoint); Hosted-UI / federated
// (OAuth) sessions refresh at /oauth2/token as before.
async function refreshTokens(refreshToken: string): Promise<string | undefined> {
  // In-memory method wins (robust to a transient method-key read error mid-session);
  // fall back to the stored value on a cold launch. WHIT-178.
  const method = sessionAuthMethod ?? (await getAuthMethod());
  return method === "srp"
    ? refreshViaInitiateAuth(refreshToken)
    : refreshViaOAuth(refreshToken);
}

// OAuth (Hosted UI / federated Google) refresh: the /oauth2/token refresh grant.
async function refreshViaOAuth(refreshToken: string): Promise<string | undefined> {
  const domain = hostedUiDomain();
  const clientId = appClientId();
  if (!domain || !clientId) return undefined;
  try {
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
    return token.idToken;
  } catch {
    return undefined;
  }
}

// SRP (native email/password) refresh: InitiateAuth REFRESH_TOKEN_AUTH against the
// cognito-idp endpoint (region derived from the pool id). Public client → no
// SECRET_HASH. Always returns an id token on success (unlike the OAuth grant for an
// SRP-minted token). WHIT-178.
async function refreshViaInitiateAuth(refreshToken: string): Promise<string | undefined> {
  const clientId = appClientId();
  const poolId = userPoolId();
  if (!clientId || !poolId) return undefined;
  const region = poolId.split("_")[0];
  try {
    const res = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      AuthenticationResult?: { IdToken?: string; AccessToken?: string; RefreshToken?: string; ExpiresIn?: number };
    };
    const r = data.AuthenticationResult;
    if (!r?.IdToken) return undefined;
    cacheToken({
      idToken: r.IdToken,
      accessToken: r.AccessToken ?? "",
      // InitiateAuth returns ExpiresIn as a DURATION (seconds); pair it with "now" as
      // the issue time — cacheToken/isNearExpiry treat expiresIn as a duration.
      issuedAt: Math.floor(Date.now() / 1000),
      expiresIn: r.ExpiresIn ?? 3600,
      // Refresh responses omit the refresh token; cacheToken falls back to the cached
      // one, and REFRESH_TOKEN_AUTH keeps the existing token valid.
      refreshToken: r.RefreshToken,
    });
    if (r.RefreshToken) await setRefreshToken(r.RefreshToken);
    return r.IdToken;
  } catch {
    return undefined;
  }
}

// Restore/refresh for the NON-biometric paths (getAuthToken, restoreSession): pull
// the stored refresh token and swap it for a fresh id token. On success → 'authed';
// on any failure → clearSession() ('anon', so the gate sends the user to login). The
// biometric unlock path does NOT use this — it owns 'locked' on failure (WHIT-171).
async function refreshFromStoredToken(): Promise<string | undefined> {
  // Prefer the in-memory refresh token (seeded by signIn or by the one-time
  // biometric unlock): this keeps hourly refreshes from re-reading the guarded
  // keychain and re-prompting Face ID. Only fall back to a keychain read (which,
  // when guarded, IS the prompt) when memory is empty — a cold, non-biometric
  // launch, where the read is unguarded and silent.
  const refreshToken = session?.refreshToken ?? (await getRefreshToken());
  if (!refreshToken) {
    clearSession();
    return undefined;
  }
  const idToken = await refreshTokens(refreshToken);
  if (idToken) {
    setStatus("authed");
    return idToken;
  }
  clearSession();
  return undefined;
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
    await clearStoredSession();
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

// --- biometric unlock (WHIT-161) ------------------------------------------------

/**
 * Whether a session marker is stored, WITHOUT reading the guarded token (which
 * would pop Face ID). The gate uses this on launch to decide "show the lock
 * screen" vs "no session, sign in". Never throws.
 */
export async function hasStoredSession(): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require("expo-secure-store");
    return (await SecureStore.getItemAsync(SESSION_SENTINEL_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Reveal a locked session by reading the biometric-guarded refresh token — that
 * read IS the Face ID / Touch ID prompt — then silently refreshing. Success →
 * `authed`. A cancelled prompt (read throws) or a failed refresh → stays `locked`
 * (the lock screen offers retry + sign-in-again). A `null` read (no token, or the
 * key was invalidated because biometrics changed) → clear the stale session and
 * drop to `anon` for a clean re-login. Never throws.
 */
export function unlock(): Promise<boolean> {
  // Single-flight: a double-tap on the lock screen's Unlock button, or a launch
  // unlock overlapping a resume unlock, must not stack two Face ID prompts. Share
  // the one in-flight attempt (mirrors the refresh single-flight).
  if (!unlockInFlight) {
    unlockInFlight = performUnlock().finally(() => {
      unlockInFlight = null;
    });
  }
  return unlockInFlight;
}

async function performUnlock(): Promise<boolean> {
  setStatus("locked");
  try {
    // The guarded keychain read is the biometric prompt.
    const refreshToken = await getRefreshToken();
    if (!refreshToken) {
      // No token, or biometrics changed and invalidated the guarded key → treat as
      // "session gone" and re-login rather than dead-ending on the lock screen.
      await clearStoredSession();
      clearSession(); // → anon
      return false;
    }
    // Seed the in-memory refresh token so the refresh below (and every later hourly
    // refresh) reuses it — one biometric prompt per launch/resume, never per refresh.
    session = { idToken: undefined, accessToken: "", issuedAt: 0, expiresIn: 0, refreshToken };
    // Refresh via the pure helper (NOT refreshFromStoredToken): on an offline failure
    // it must NOT broadcast 'anon'. unlock owns the terminal status here, so the gate
    // never renders a stray login redirect before the lock screen. WHIT-171.
    const idToken = await refreshTokens(refreshToken);
    if (idToken) {
      setStatus("authed");
      return true;
    }
    // Valid-looking token but the refresh failed (e.g. offline): keep the session
    // stored and stay locked so the user can retry — no transient 'anon' flash.
    setStatus("locked");
    return false;
  } catch {
    // Read threw — typically the user cancelled the prompt. Stay locked; retry and
    // sign-in-again remain available, so we never hard-lock.
    setStatus("locked");
    return false;
  }
}

/** Drop the in-memory session (incl. the refresh token) and re-seal to `locked`. */
export function lock(): void {
  session = null;
  setStatus("locked");
}

/**
 * Launch decision for the gate: if biometrics are active and a stored session
 * exists, seal it (`locked`) and prompt to unlock; otherwise take the normal
 * WHIT-160 restore path. Never throws.
 */
export async function unlockOrRestore(): Promise<void> {
  if (canBiometricLock() && (await hasStoredSession())) {
    await unlock();
  } else {
    await restoreSession();
  }
}

// --- SecureStore wrappers (lazy require; web/simulator throw is swallowed) --------

async function setRefreshToken(value: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  const opts = secureOpts();
  // WHIT-170: on iOS, UPDATING an existing requireAuthentication item re-prompts Face
  // ID (per expo-secure-store). When the item is guarded, delete first so the write
  // takes the CREATE path, which is silent — otherwise a rotated refresh token
  // (Cognito rotation enabled) would pop Face ID on an otherwise-silent hourly
  // refresh, and a second time inside unlock(). Deletion never prompts; on a fresh
  // install the delete is a harmless no-op. Unguarded writes don't prompt — skip it.
  if (opts.requireAuthentication) {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, value, opts);
}

async function getRefreshToken(): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, secureOpts());
}

async function setSessionSentinel(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  // Unguarded: the whole point is to read it without a biometric prompt.
  await SecureStore.setItemAsync(SESSION_SENTINEL_KEY, "1");
}

// WHIT-178: record/read which surface minted the session, so the refresh path can
// match it. Unguarded (not secret); a missing value reads as null → OAuth path.
async function setAuthMethod(method: "srp" | "oauth"): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  await SecureStore.setItemAsync(AUTH_METHOD_KEY, method);
}

async function getAuthMethod(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SecureStore = require("expo-secure-store");
    return await SecureStore.getItemAsync(AUTH_METHOD_KEY);
  } catch {
    return null; // unreadable → default to the OAuth refresh path
  }
}

async function clearStoredSession(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SecureStore = require("expo-secure-store");
  await SecureStore.deleteItemAsync(SESSION_SENTINEL_KEY);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  await SecureStore.deleteItemAsync(AUTH_METHOD_KEY);
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
