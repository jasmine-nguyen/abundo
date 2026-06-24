import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Rect, Polyline, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { C, FONT } from '../src/theme';
import { Glyph } from '../src/icons';

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

export default function Login() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const go = () => router.replace('/(tabs)/budgets');

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

      <View style={{ gap: 12 }}>
        <View>
          <Text style={styles.label}>EMAIL</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@email.com"
            placeholderTextColor={C.placeholder}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
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
            style={styles.input}
          />
        </View>

        <Pressable onPress={go} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>Log in</Text>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.dividerText}>or continue with</Text>
          <View style={styles.divider} />
        </View>

        <Pressable onPress={go} style={[styles.altBtn, { backgroundColor: C.card }]}>
          <Glyph name="building" size={20} color="#ff9900" />
          <Text style={styles.altText}>Continue with AWS Cognito</Text>
        </Pressable>
        <Pressable onPress={go} style={[styles.altBtn, { backgroundColor: 'transparent' }]}>
          <Glyph name="target" size={20} color="#e2e2e8" />
          <Text style={styles.altText}>Log in with Face ID</Text>
        </Pressable>
      </View>

      <Text style={styles.footer}>
        New to Whittle? <Text style={styles.footerLink}>Create account</Text>
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 26 },
  brand: { alignItems: 'center', marginBottom: 38 },
  wordmark: { fontFamily: FONT.display, fontWeight: '800', fontSize: 34, color: '#fff', letterSpacing: -1, marginTop: 18 },
  tagline: { fontFamily: FONT.body, fontSize: 14, color: C.textMid, marginTop: 5 },
  label: { fontFamily: FONT.body, fontSize: 12, fontWeight: '600', color: C.textMid, marginHorizontal: 2, marginBottom: 7 },
  input: { width: '100%', paddingVertical: 15, paddingHorizontal: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,.08)', backgroundColor: C.card, borderRadius: 14, color: '#fff', fontFamily: FONT.body, fontSize: 15 },
  primaryBtn: { marginTop: 6, paddingVertical: 16, borderRadius: 15, backgroundColor: C.accent, alignItems: 'center' },
  primaryText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.accentInk },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 8 },
  divider: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,.08)' },
  dividerText: { fontFamily: FONT.body, fontSize: 12, color: C.textFaint },
  altBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,.1)', borderRadius: 15 },
  altText: { fontFamily: FONT.body, fontSize: 14.5, fontWeight: '600', color: '#e2e2e8' },
  footer: { textAlign: 'center', marginTop: 26, fontFamily: FONT.body, fontSize: 14, color: '#83838d' },
  footerLink: { color: C.accentSoft, fontWeight: '600' },
});
