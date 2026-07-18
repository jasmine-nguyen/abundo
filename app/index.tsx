import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Polyline, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { C, FONT, tint } from '../src/theme';
import { signInWithPassword, signInWithGoogle, completeNewPassword, requestPasswordReset, confirmPasswordReset } from '../src/auth';

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
      <Polyline points="15,18 23,40 32,27 41,40 49,24" fill="none" stroke={C.heroInk} strokeWidth={5.2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={49} cy={24} r={3.1} fill={C.heroInk} />
    </Svg>
  );
}

type Mode = 'signin' | 'newPassword' | 'forgotRequest' | 'forgotConfirm';

// WHIT-180/181/182: the real native login. Email/password (WHIT-178 SRP) + Continue
// with Google (WHIT-179), the first-login set-password step (WHIT-181), and the
// forgot-password reset flow (WHIT-182). Everything lives on this one signed-out route
// because the auth gate only lets anon users sit on the index. Real Face ID is the
// lock screen (AuthGate), not here.
export default function Login() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [busy, setBusy] = useState<'password' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // non-error confirmations
  const [mode, setMode] = useState<Mode>('signin');

  const go = () => router.replace('/(tabs)/budgets');
  const disabled = busy !== null;
  const canSubmit = email.trim().length > 0 && pass.length > 0;
  const canSetPassword = newPass.length > 0 && confirmPass.length > 0;
  const canSendReset = email.trim().length > 0;
  const canReset = resetCode.trim().length > 0 && newPass.length > 0 && confirmPass.length > 0;

  const logIn = async () => {
    if (busy || !canSubmit) return;
    setError(null);
    setNotice(null);
    setBusy('password');
    let res: Awaited<ReturnType<typeof signInWithPassword>>;
    try {
      res = await signInWithPassword(email, pass);
    } catch {
      // signInWithPassword is never-throw by contract; belt-and-braces so a future
      // throw path can never leave the spinner stuck forever.
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
      // NEW_PASSWORD_REQUIRED (WHIT-181) — switch to the set-a-password step.
      setNewPass('');
      setConfirmPass('');
      setMode('newPassword');
      return;
    }
    setError(res.error);
  };

  const setPassword = async () => {
    if (busy || !canSetPassword) return;
    if (newPass !== confirmPass) {
      setError('Those passwords don’t match.');
      return;
    }
    setError(null);
    setBusy('password');
    let res: Awaited<ReturnType<typeof completeNewPassword>>;
    try {
      res = await completeNewPassword(newPass);
    } catch {
      setBusy(null);
      setError('Something went wrong. Please try again.');
      return;
    }
    setBusy(null);
    if (res.ok) {
      go();
      return;
    }
    setError(res.error);
  };

  const withGoogle = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
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

  // WHIT-182: send the reset code, then confirm it with a new password.
  const sendResetCode = async () => {
    if (busy || !canSendReset) return;
    setError(null);
    setNotice(null);
    setBusy('password');
    let res: Awaited<ReturnType<typeof requestPasswordReset>>;
    try {
      res = await requestPasswordReset(email);
    } catch {
      setBusy(null);
      setError('Something went wrong. Please try again.');
      return;
    }
    setBusy(null);
    if (res.ok) {
      setResetCode('');
      setNewPass('');
      setConfirmPass('');
      setNotice('We emailed you a reset code. Enter it below with a new password.');
      setMode('forgotConfirm');
      return;
    }
    setError(res.error);
  };

  const submitReset = async () => {
    if (busy || !canReset) return;
    setNotice(null); // clear the "code sent" notice so it can't stack above an error
    if (newPass !== confirmPass) {
      setError('Those passwords don’t match.');
      return;
    }
    setError(null);
    setBusy('password');
    let res: Awaited<ReturnType<typeof confirmPasswordReset>>;
    try {
      res = await confirmPasswordReset(email, resetCode, newPass);
    } catch {
      setBusy(null);
      setError('Something went wrong. Please try again.');
      return;
    }
    setBusy(null);
    if (res.ok) {
      setPass('');
      setResetCode('');
      setNewPass('');
      setConfirmPass('');
      setError(null);
      setNotice('Password reset. Sign in with your new password.');
      setMode('signin');
      return;
    }
    setError(res.error);
  };

  const startForgot = () => {
    setError(null);
    setNotice(null);
    setResetCode('');
    setNewPass('');
    setConfirmPass('');
    setMode('forgotRequest');
  };

  const backToSignin = () => {
    setMode('signin');
    setError(null);
    setNotice(null);
    setNewPass('');
    setConfirmPass('');
    setResetCode('');
  };

  const pwInput = (value: string, onChangeText: (t: string) => void, testID: string, onSubmit?: () => void) => (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder="••••••••"
      placeholderTextColor={C.placeholder}
      secureTextEntry
      editable={!disabled}
      returnKeyType={onSubmit ? 'go' : 'next'}
      onSubmitEditing={onSubmit}
      style={styles.input}
      testID={testID}
    />
  );

  let form: React.ReactNode;
  if (mode === 'newPassword') {
    form = (
      <View style={{ gap: 12 }} testID="newpass-form">
        <Text style={styles.formIntro}>Set a new password to finish signing in.</Text>
        <View>
          <Text style={styles.label}>NEW PASSWORD</Text>
          {pwInput(newPass, setNewPass, 'newpass-new')}
        </View>
        <View>
          <Text style={styles.label}>CONFIRM PASSWORD</Text>
          {pwInput(confirmPass, setConfirmPass, 'newpass-confirm', setPassword)}
        </View>
        <Pressable onPress={setPassword} disabled={disabled || !canSetPassword} style={[styles.primaryBtn, { opacity: disabled || !canSetPassword ? 0.6 : 1 }]} testID="newpass-submit">
          {busy === 'password' ? <ActivityIndicator color={C.accentInk} /> : <Text style={styles.primaryText}>Set password &amp; sign in</Text>}
        </Pressable>
        <Pressable onPress={backToSignin} disabled={disabled} style={styles.forgotBtn} testID="newpass-back">
          <Text style={styles.forgotText}>← Back to sign in</Text>
        </Pressable>
      </View>
    );
  } else if (mode === 'forgotRequest') {
    form = (
      <View style={{ gap: 12 }} testID="forgot-request-form">
        <Text style={styles.formIntro}>Enter your email and we’ll send a reset code.</Text>
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
            returnKeyType="go"
            onSubmitEditing={sendResetCode}
            style={styles.input}
            testID="forgot-email"
          />
        </View>
        <Pressable onPress={sendResetCode} disabled={disabled || !canSendReset} style={[styles.primaryBtn, { opacity: disabled || !canSendReset ? 0.6 : 1 }]} testID="forgot-send">
          {busy === 'password' ? <ActivityIndicator color={C.accentInk} /> : <Text style={styles.primaryText}>Send reset code</Text>}
        </Pressable>
        <Pressable onPress={backToSignin} disabled={disabled} style={styles.forgotBtn} testID="forgot-back">
          <Text style={styles.forgotText}>← Back to sign in</Text>
        </Pressable>
      </View>
    );
  } else if (mode === 'forgotConfirm') {
    form = (
      <View style={{ gap: 12 }} testID="forgot-confirm-form">
        <Text style={styles.formIntro}>Enter the code we emailed you and a new password.</Text>
        <View>
          <Text style={styles.label}>RESET CODE</Text>
          <TextInput
            value={resetCode}
            onChangeText={setResetCode}
            placeholder="123456"
            placeholderTextColor={C.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            editable={!disabled}
            style={styles.input}
            testID="forgot-code"
          />
        </View>
        <View>
          <Text style={styles.label}>NEW PASSWORD</Text>
          {pwInput(newPass, setNewPass, 'forgot-new')}
        </View>
        <View>
          <Text style={styles.label}>CONFIRM PASSWORD</Text>
          {pwInput(confirmPass, setConfirmPass, 'forgot-confirm-pass', submitReset)}
        </View>
        <Pressable onPress={submitReset} disabled={disabled || !canReset} style={[styles.primaryBtn, { opacity: disabled || !canReset ? 0.6 : 1 }]} testID="forgot-submit">
          {busy === 'password' ? <ActivityIndicator color={C.accentInk} /> : <Text style={styles.primaryText}>Reset password</Text>}
        </Pressable>
        <Pressable onPress={backToSignin} disabled={disabled} style={styles.forgotBtn} testID="forgot-back">
          <Text style={styles.forgotText}>← Back to sign in</Text>
        </Pressable>
      </View>
    );
  } else {
    form = (
      <View style={{ gap: 12 }} testID="signin-form">
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
          {pwInput(pass, setPass, 'login-password', logIn)}
        </View>

        <Pressable onPress={logIn} disabled={disabled || !canSubmit} style={[styles.primaryBtn, { opacity: disabled || !canSubmit ? 0.6 : 1 }]} testID="login-submit">
          {busy === 'password' ? <ActivityIndicator color={C.accentInk} /> : <Text style={styles.primaryText}>Log in</Text>}
        </Pressable>

        <Pressable onPress={startForgot} disabled={disabled} style={styles.forgotBtn} testID="login-forgot">
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
    );
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 30, paddingBottom: insets.bottom + 30 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brand}>
        <Logo />
        <Text style={styles.wordmark}>Abundo</Text>
        <Text style={styles.tagline}>Pay the mortgage down to nothing.</Text>
      </View>

      {notice ? (
        <View style={styles.noticeBox} testID="login-notice">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBox} testID="login-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {form}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 26 },
  brand: { alignItems: 'center', marginBottom: 30 },
  wordmark: { fontFamily: FONT.display, fontWeight: '800', fontSize: 34, color: '#fff', letterSpacing: -1, marginTop: 18 },
  tagline: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 5 },
  formIntro: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, textAlign: 'center', marginBottom: 2 },
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
  noticeBox: { backgroundColor: tint(C.good, 0.12), borderWidth: 1, borderColor: tint(C.good, 0.35), borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 14 },
  noticeText: { fontFamily: FONT.body, fontSize: 13.5, color: C.good, textAlign: 'center' },
});
