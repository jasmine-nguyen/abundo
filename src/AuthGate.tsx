// Auth gate (WHIT-160). Wraps the router tree in app/_layout.tsx and redirects
// based on session state — but only when EXPO_PUBLIC_AUTH_GATE_ENABLED === 'true'
// (default off). With the flag off it renders children unchanged, so today's
// behaviour (any tab reachable, no login required) is exactly preserved until the
// gate is switched on after an on-device verification. The redirect DECISION lives
// in the pure gateRedirect() in src/auth.ts (unit-tested); this component only
// wires it to expo-router primitives.
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Redirect, useSegments, useRootNavigationState } from "expo-router";
import { C } from "./theme";
import { AuthStatus, gateRedirect, getStatus, subscribe, restoreSession } from "./auth";

/** Subscribe to auth status and kick off a one-time session restore on mount. */
function useAuthSession(): AuthStatus {
  const [current, setCurrent] = useState<AuthStatus>(getStatus());
  useEffect(() => {
    const unsubscribe = subscribe(() => setCurrent(getStatus()));
    void restoreSession();
    return unsubscribe;
  }, []);
  return current;
}

export function AuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const status = useAuthSession();
  const segments = useSegments();
  const navState = useRootNavigationState();

  const enabled = process.env.EXPO_PUBLIC_AUTH_GATE_ENABLED === "true";
  const navReady = navState?.key != null;
  // The login screen is the ONLY root route with no segments. Everything else —
  // the (tabs) group AND root-level detail screens like /loan, /rules,
  // /budget/[id] — is a protected screen an authed user reaches from inside the app.
  // (Cast: expo-router types useSegments() as a fixed-length tuple, but the index
  // route yields an empty array at runtime.)
  const onIndex = (segments as string[]).length === 0;

  // While restoring a returning session, hold a plain background instead of flashing
  // a protected screen (only when the gate is on — off means render as today).
  if (enabled && status === "loading") {
    return <View style={{ flex: 1, backgroundColor: C.bg }} />;
  }

  const target = gateRedirect({ enabled, navReady, status, onIndex });
  if (target) return <Redirect href={target} />;

  return <>{children}</>;
}
