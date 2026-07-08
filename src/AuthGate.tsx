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
import { View, Text, Pressable, StyleSheet, AppState } from "react-native";
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

    // Resume re-lock: on a genuine background→active return, drop the in-memory
    // token and re-prompt. The biometric sheet itself sends the app to 'inactive'
    // (NOT 'background'), so keying on a tracked 'background' previous state avoids
    // an unlock→sheet→active→unlock prompt loop.
    let previousState = AppState.currentState;
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (
        previousState === "background" &&
        nextState === "active" &&
        canBiometricLock() &&
        getStatus() === "authed"
      ) {
        lock();
        void unlock();
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
      <Text style={styles.lockTitle}>Whittle is locked</Text>
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

  // A biometric-sealed session shows the lock screen until Face ID succeeds
  // ('locked' is only ever set when biometrics are active).
  if (status === "locked") return <LockScreen />;

  // While restoring a returning session, hold a plain background instead of
  // flashing a protected screen.
  if (status === "loading") {
    return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  const target = gateRedirect({ navReady, status, onIndex });
  if (target) return <Redirect href={target} />;

  return <>{children}</>;
}

const styles = StyleSheet.create({
  lock: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center", padding: 32, gap: 14 },
  lockTitle: { fontFamily: FONT.display, fontWeight: "800", fontSize: 24, color: "#fff" },
  lockSubtitle: { fontFamily: FONT.body, fontSize: 15, color: C.textMid, marginBottom: 10 },
  unlockButton: { paddingVertical: 15, paddingHorizontal: 40, borderRadius: 15, backgroundColor: C.accent, alignItems: "center" },
  unlockText: { fontFamily: FONT.body, fontSize: 16, fontWeight: "700", color: C.accentInk },
  signOutButton: { paddingVertical: 12, paddingHorizontal: 24 },
  signOutText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: "600", color: C.accentSoft },
});
