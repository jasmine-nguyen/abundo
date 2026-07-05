import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Polyline, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { C, FONT } from '../src/theme';
import { signInWithPassword, signInWithGoogle } from '../src/auth';

// Required so a returning OAuth redirect (Google) can dismiss the auth browser and
// resolve the pending promptAsync (a no-op on native, where promptAsync resolves).
WebBrowser.maybeCompleteAuthSession();

function Logo() {
  return (
    <Svg width={76} height={76} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="wlogo" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#8e9cff" />
          <Stop offset="1" stopColor="#5d68d6" />
        </LinearGradient>
      </Defs>
      <Rect width={64} height={64} rx={18} fill="url(#wlogo)" />
      <Polyline points="15,18 23,40 32,27 41,40 49,24" fill="none" stroke="#15123a" strokeWidth={5.2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={49} cy={24} r={3.1} fill="#15123a" />
    </Svg>
  );
}

// WHIT-180: the real native login. Email/password (WHIT-178 SRP) + Continue with
// Google (WHIT-179, straight to Google's sheet). The old Hosted-UI "AWS Cognito"
// button, the placeholder Face ID button, and the "Create account" link are gone;
// real Face ID lives on the lock screen (AuthGate), not here.
export default function Login() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<'password' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = () => router.replace('/(tabs)/budgets');
  const disabled = busy !== null;
  // Don't fire a pointless round-trip (and a confusing "incorrect password") on blank
  // fields — keep Log in disabled until both are non-empty.
  const canSubmit = email.trim().length > 0 && pass.length > 0;

  const logIn = async () => {
    if (busy || !canSubmit) return;
    setError(null);
    setBusy('password');
    let res: Awaited<ReturnType<typeof signInWithPassword>>;
    try {
      res = await signInWithPassword(email, pass);
    } catch {
      // signInWithPassword is never-throw by contract; this is belt-and-braces so a
      // future throw path can never leave the spinner stuck forever.
      setBusy(null);
      setError('Something went wrong. Please try again.');
      return;
    }
    setBusy(null); // clear BEFORE navigating, so we never setState after unmount
    if (res.ok) {
      go();
      return;
    }
    if ('challenge' in res) {
      // NEW_PASSWORD_REQUIRED — the full set-a-password flow lands in WHIT-181.
      setError('This account needs a new password set before you can sign in.');
      return;
    }
    setError(res.error);
  };

  const withGoogle = async () => {
    if (busy) return;
    setError(null);
    setBusy('google');
    let ok = false;
    try {
      ok = await signInWithGoogle();
    } catch {
      setBusy(null);
      return;
    }
    setBusy(null);
    if (ok) go();
    // A false result is almost always a user cancel — stay quietly on the screen.
  };

  // WHIT-182 (stub): the real reset-by-email flow isn't built yet.
  const forgot = () => setError('Password reset is coming soon. For now, reset it from the AWS console.');

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 30, paddingBottom: insets.bottom + 30 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brand}>
        <Logo />
        <Text style={styles.wordmark}>Whittle</Text>
        <Text style={styles.tagline}>Whittle the mortgage down to nothing.</Text>
      </View>

      {error ? (
        <View style={styles.errorBox} testID="login-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={{ gap: 12 }}>
        <View>
          <Text style={styles.label}>EMAIL</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@email.com"
            placeholderTextColor={C.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            editable={!disabled}
            style={styles.input}
            testID="login-email"
          />
        </View>
        <View>
          <Text style={styles.label}>PASSWORD</Text>
          <TextInput
            value={pass}
            onChangeText={setPass}
            placeholder="••••••••"
            placeholderTextColor={C.placeholder}
            secureTextEntry
            editable={!disabled}
            returnKeyType="go"
            onSubmitEditing={logIn}
            style={styles.input}
            testID="login-password"
          />
        </View>

        <Pressable onPress={logIn} disabled={disabled || !canSubmit} style={[styles.primaryBtn, { opacity: disabled || !canSubmit ? 0.6 : 1 }]} testID="login-submit">
          {busy === 'password' ? <ActivityIndicator color={C.accentInk} /> : <Text style={styles.primaryText}>Log in</Text>}
        </Pressable>

        <Pressable onPress={forgot} disabled={disabled} style={styles.forgotBtn} testID="login-forgot">
          <Text style={styles.forgotText}>Forgot password?</Text>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.divider} />
        </View>

        <Pressable onPress={withGoogle} disabled={disabled} style={[styles.altBtn, { opacity: disabled ? 0.6 : 1 }]} testID="login-google">
          <Text style={styles.altText}>{busy === 'google' ? 'Connecting…' : 'Continue with Google'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 26 },
  brand: { alignItems: 'center', marginBottom: 30 },
  wordmark: { fontFamily: FONT.display, fontWeight: '800', fontSize: 34, color: '#fff', letterSpacing: -1, marginTop: 18 },
  tagline: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 5 },
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', color: C.textMid, marginHorizontal: 2, marginBottom: 7 },
  input: { width: '100%', paddingVertical: 15, paddingHorizontal: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', backgroundColor: C.card, borderRadius: 14, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  primaryBtn: { marginTop: 6, paddingVertical: 16, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', minHeight: 53 },
  primaryText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.accentInk },
  forgotBtn: { alignSelf: 'center', paddingVertical: 4 },
  forgotText: { fontFamily: FONT.body, fontSize: 13.5, fontWeight: '600', color: C.accentSoft },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 4 },
  divider: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,.08)' },
  dividerText: { fontFamily: FONT.body, fontSize: 12, color: C.textFaint },
  altBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', borderRadius: 15, minHeight: 50 },
  altText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: '#e2e2e8' },
  errorBox: { backgroundColor: 'rgba(255,107,107,.12)', borderWidth: 1, borderColor: 'rgba(255,107,107,.35)', borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 14 },
  errorText: { fontFamily: FONT.body, fontSize: 13.5, color: C.bad, textAlign: 'center' },
});
