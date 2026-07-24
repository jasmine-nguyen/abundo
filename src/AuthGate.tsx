// Auth gate (WHIT-160/161/162). Wraps the router tree in app/_layout.tsx.
//
// WHIT-162: login is MANDATORY — the static secret is retired, so the app can't
// function signed-out. The gate is unconditional: a signed-out user on any
// protected route is redirected to the login screen. The redirect DECISION is the
// pure gateRedirect() in src/auth.ts.
//
// WHIT-161 (Face ID): when biometric locking is active (EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED
// on + supported device) and a stored session exists, the gate seals the app to a
// 'locked' state on launch and on resume-from-background, showing a lock screen
// until the biometric-guarded keychain read (the Face ID prompt) succeeds. Face ID
// stays OPT-IN (the flag); login itself is not optional.
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, AppState, Keyboard, Image } from "react-native";
import { Redirect, useSegments, useRootNavigationState } from "expo-router";
import { C, FONT } from "./theme";
import {
  AuthStatus,
  gateRedirect,
  getStatus,
  subscribe,
  unlockOrRestore,
  canBiometricLock,
  unlock,
  lock,
  signOut,
} from "./auth";

/**
 * How long Abundo must sit in the background before a resume re-prompts Face ID. A
 * briefer switch-away (flick to another app, glance at a notification, lock the phone
 * for a moment) resumes straight in — mirrors iOS's "Require Passcode → After 10
 * minutes". A full close (force-quit / cold launch) always re-locks via unlockOrRestore,
 * independent of this window.
 */
export const RELOCK_GRACE_MS = 10 * 60 * 1000;

/** Subscribe to auth status, run the launch unlock/restore, and re-lock on resume. */
function useAuthSession(): AuthStatus {
  const [current, setCurrent] = useState<AuthStatus>(getStatus());
  useEffect(() => {
    const unsubscribe = subscribe(() => setCurrent(getStatus()));
    // WHIT-162: login is mandatory (the static secret is retired), so the launch
    // path is unconditional — biometric-unlock a stored session if biometrics are
    // active (checked inside unlockOrRestore/canBiometricLock), else a normal restore.
    // Face ID stays opt-in via EXPO_PUBLIC_AUTH_BIOMETRIC_ENABLED (canBiometricLock).
    void unlockOrRestore();

    // Resume re-lock: on a genuine background→active return, re-prompt Face ID ONLY if
    // the app was away at least RELOCK_GRACE_MS; a briefer switch-away resumes straight
    // in. The biometric sheet itself sends the app to 'inactive' (NOT 'background'), so
    // keying on a tracked 'background' previous state avoids an unlock→sheet→active→unlock
    // prompt loop.
    let previousState = AppState.currentState;
    // Stamped each time we leave to the background, so the resume below can measure how
    // long we were away and apply the grace window.
    let backgroundedAt: number | null = null;
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "background") backgroundedAt = Date.now();
      if (
        previousState === "background" &&
        nextState === "active" &&
        canBiometricLock() &&
        getStatus() === "authed"
      ) {
        // A short absence (app kept in memory) resumes straight in; only an absence of
        // RELOCK_GRACE_MS or more re-prompts. A null stamp can't occur on this branch (we
        // only arrive from 'background', which stamps), but treat it as re-lock defensively.
        const awayMs = backgroundedAt == null ? Infinity : Date.now() - backgroundedAt;
        if (awayMs >= RELOCK_GRACE_MS) {
          lock();
          void unlock();
        }
      }
      previousState = nextState;
    });

    return () => {
      unsubscribe();
      appStateSubscription.remove();
    };
  }, []);
  return current;
}

/** The biometric lock screen: retry the prompt, or fall back to a full re-login. */
function LockScreen(): React.ReactElement {
  return (
    <View style={styles.lock}>
      <Image
        source={require("../assets/abundo-tree-mark.png")}
        style={styles.lockLogo}
        accessibilityIgnoresInvertColors
        importantForAccessibility="no"
        testID="lock-logo"
      />
      <Text style={styles.lockTitle}>Abundo is locked</Text>
      <Text style={styles.lockSubtitle}>Unlock with Face ID to continue.</Text>
      <Pressable onPress={() => void unlock()} style={styles.unlockButton}>
        <Text style={styles.unlockText}>Unlock</Text>
      </Pressable>
      <Pressable onPress={() => void signOut()} style={styles.signOutButton}>
        <Text style={styles.signOutText}>Sign in again</Text>
      </Pressable>
    </View>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const status = useAuthSession();
  const segments = useSegments();
  const navState = useRootNavigationState();

  // WHIT-162: the gate is unconditional — login is required to use the app.
  const navReady = navState?.key != null;
  // The login screen is the ONLY root route with no segments. Everything else —
  // the (tabs) group AND root-level detail screens like /loan, /rules,
  // /budget/[id] — is a protected screen an authed user reaches from inside the app.
  // (Cast: expo-router types useSegments() as a fixed-length tuple, but the index
  // route yields an empty array at runtime.)
  const onIndex = (segments as string[]).length === 0;
  // A biometric-sealed session ('locked' is only ever set when biometrics are active) now
  // keeps the app MOUNTED underneath an opaque lock cover (rendered in the tail below), so
  // scroll/form state survives the lock→unlock instead of being destroyed (WHIT-266).
  const locked = status === "locked";

  // WHIT-266: dismiss the keyboard as the lock cover goes up. Now that the app stays mounted
  // under the cover, a focused TextInput keeps first-responder — and iOS draws the software
  // keyboard as a system window our RN cover can't paint over, so blur it explicitly.
  useEffect(() => {
    if (locked) Keyboard.dismiss();
  }, [locked]);

  // While restoring a returning session, hold a plain background instead of flashing a
  // protected screen. Cold launch only — nothing is mounted yet, so there's nothing to
  // preserve; this is the one branch that still swaps the whole subtree.
  if (status === "loading") {
    return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  const target = gateRedirect({ navReady, status, onIndex });
  // WHIT-265/266: the children (the root <Stack>) stay MOUNTED at a FIXED tree position —
  // through redirects (WHIT-265) AND through the lock (WHIT-266) — so navigation, scroll, and
  // form state all survive. `content` is UNCONDITIONAL: rendering something else instead of the
  // children, or wrapping them only sometimes, moves their tree position and unmounts the Stack;
  // navigation then resets to the index route, the gate re-redirects, and the mount/unmount
  // ping-pong exceeds React's update depth — an instant launch crash in release builds. Only the
  // covers on top and `content`'s a11y props change with status. The `loading` branch above is
  // the sole remaining full-subtree swap (cold launch, nothing to preserve).
  // - Redirect cover (WHIT-265): opaque + touch shield while a redirect completes (visual only —
  //   a11y-hiding is lock-only). gateRedirect returns null while locked, so it never competes
  //   with the lock cover.
  // - Lock cover (WHIT-266): opaque, touch-blocking, screen-reader-hidden shield over the
  //   still-mounted app while biometrically locked. `content` is marked a11y-hidden while locked
  //   (belt) and the cover is marked modal (suspenders) so VoiceOver/TalkBack can't read behind it.
  return (
    <View style={styles.gate}>
      <View
        testID="gate-content"
        style={styles.content}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {target != null && (
        <View style={styles.cover} testID="gate-cover">
          <Redirect href={target} />
        </View>
      )}
      {locked && (
        <View style={styles.lockCover} testID="lock-cover" accessibilityViewIsModal>
          <LockScreen />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gate: { flex: 1 },
  // Holds the mounted app. flex:1 fills the gate — layout-neutral vs children being a direct
  // child of `gate` — but its FIXED presence is what keeps the Stack from remounting (WHIT-266).
  content: { flex: 1 },
  // NOTE: explicit four-edge fill on purpose — RN 0.85 removed StyleSheet.absoluteFillObject.
  // zIndex above the in-gate maximum (floating headers use 10/20) so the cover always
  // paints on top, including on web; the 200/300 Overlays live OUTSIDE AuthGate.
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 50, backgroundColor: C.bg },
  // The lock cover sits above even the redirect cover (they never co-occur — gateRedirect is
  // null while locked — but keep lock topmost defensively). Opaque C.bg + default pointerEvents
  // so touches never reach the covered app.
  lockCover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 60, backgroundColor: C.bg },
  lock: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  lockLogo: { width: 88, height: 88, marginBottom: 6 },
  lockTitle: { fontFamily: FONT.display, fontWeight: "800", fontSize: 24, color: "#fff" },
  lockSubtitle: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, marginBottom: 10 },
  unlockButton: { paddingVertical: 15, paddingHorizontal: 40, borderRadius: 15, backgroundColor: C.accent, alignItems: "center" },
  unlockText: { fontFamily: FONT.body, fontSize: 16, fontWeight: "700", color: C.accentInk },
  signOutButton: { paddingVertical: 12, paddingHorizontal: 24 },
  signOutText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: "600", color: C.accentSoft },
});
