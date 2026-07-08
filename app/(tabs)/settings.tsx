import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { C, FONT } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { useAppContext } from '../../src/context';
import { useSettingsScreenData, useRulesScreenData, usePayCycle } from '../../src/queries';
import { signOut, getCurrentUser } from '../../src/auth';
import { SectionLabel } from '../../src/components/ui';
import { ScrollChromeHeader } from '../../src/motion/ScrollChromeHeader';

// WHIT-180: avatar initials from the real signed-in identity (name → first+last
// initial; else the first two letters of the email's local part). A whitespace-only
// name falls through to the email; `?` only when there's nothing usable. Exported for
// direct unit testing.
export function initialsFrom(u: { email?: string; name?: string } | null): string {
  const name = u?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
    return (first + last).toUpperCase() || '?';
  }
  if (u?.email) {
    const alnum = u.email.replace(/[^a-z0-9]/gi, ''); // drop @/dots so we never show "X@"
    if (alnum) return alnum.slice(0, 2).toUpperCase();
  }
  return '?';
}

export default function Settings() {
  const s = useAppContext(); // alerts toggle + setSheet (client-state)
  const router = useRouter();

  // WHIT-191a: the two server-backed rows (categories count + loan-facts status) now come
  // from the cached query layer. "…" while first-loading so the count never flashes "0".
  const { categoriesCount, loanReady, isLoading, refetchStale } = useSettingsScreenData();
  // WHIT-203: the rules count + pay-cycle name also come off the query layer now.
  const { rules } = useRulesScreenData();
  const { cycleName } = usePayCycle();
  useFocusEffect(useCallback(() => { refetchStale(); }, [refetchStale]));

  // WHIT-180: real identity from the Cognito ID token, not the "Jordan Diaz" mock.
  const user = getCurrentUser();
  const name = user?.name?.trim() || undefined; // ignore a whitespace-only name
  const displayName = name ?? user?.email ?? 'Signed in';
  const secondLine = name ? user?.email : undefined; // avoid repeating the email
  // Google photo, with a fallback to initials if the URL is blank or fails to load.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUri = user?.picture?.trim() ? user.picture : undefined;
  const showPhoto = !!photoUri && !photoFailed;

  // WHIT-176: actually END the session, don't just navigate. signOut() drops the
  // in-memory session synchronously (→ status 'anon'), clears the stored refresh
  // token + sentinel, and best-effort clears the Hosted UI cookie. Without it, a
  // bare router.replace('/') left the session intact and the auth gate bounced the
  // still-authed user straight back into the tabs — i.e. no working log out.
  const logOut = () => {
    void signOut();
    router.replace('/');
  };

  return (
    <ScrollChromeHeader title="Settings">
        {/* profile */}
        <View style={styles.profile}>
          {showPhoto ? (
            <Image source={{ uri: photoUri }} onError={() => setPhotoFailed(true)} style={styles.avatarImg} />
          ) : (
            <View style={styles.avatar}><Text style={styles.avatarText}>{initialsFrom(user)}</Text></View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName} numberOfLines={1}>{displayName}</Text>
            {secondLine ? <Text style={styles.profileEmail} numberOfLines={1}>{secondLine}</Text> : null}
          </View>
        </View>

        <SectionLabel>SETUP</SectionLabel>
        <View style={styles.group}>
          <Row icon="tag" label="Categories" value={isLoading ? '…' : String(categoriesCount)} onPress={() => router.push('/category')} />
          <Row icon="sliders" label="Automation rules" value={String(rules.length)} onPress={() => router.push('/rules')} />
          <Row icon="calendar" label="Pay cycle" value={cycleName()} onPress={() => s.setSheet({ mode: 'paycycle' })} />
          <Row icon="building" label="Loan details" value={isLoading ? '…' : loanReady ? 'Edit' : 'Set up'} onPress={() => router.push('/loan')} last />
        </View>

        <SectionLabel>PREFERENCES</SectionLabel>
        <View style={styles.group}>
          <View style={styles.rowBase}>
            <View style={[styles.rowIcon, { backgroundColor: 'rgba(255,255,255,.06)' }]}><Glyph name="bell" size={19} color="#b6b6c0" /></View>
            <Text style={styles.rowLabel}>Pending alerts</Text>
            <Pressable onPress={s.toggleAlerts} style={[styles.toggle, { backgroundColor: s.alerts ? C.accent : 'rgba(255,255,255,.12)' }]}>
              <View style={[styles.knob, { left: s.alerts ? 21 : 3 }]} />
            </Pressable>
          </View>
          <Pressable testID="settings-logout" onPress={logOut} style={[styles.rowBase, { borderBottomWidth: 0 }]}>
            <View style={[styles.rowIcon, { backgroundColor: 'rgba(255,107,107,.12)' }]}><Glyph name="logout" size={19} color={C.bad} /></View>
            <Text style={[styles.rowLabel, { color: C.bad }]}>Log out</Text>
          </Pressable>
        </View>

        <Text style={styles.version}>Whittle · v1.0 · death-pledge slayer</Text>
    </ScrollChromeHeader>
  );
}

function Row({ icon, label, value, onPress, last }: { icon: string; label: string; value: string; onPress: () => void; last?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.rowBase, last && { borderBottomWidth: 0 }]}>
      <View style={[styles.rowIcon, { backgroundColor: 'rgba(124,140,255,.14)' }]}><Glyph name={icon} size={19} color={C.accentSoft} /></View>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
      <Glyph name="chevron" size={18} color={C.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 20, padding: 16, marginBottom: 18 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#7079e3', alignItems: 'center', justifyContent: 'center' },
  avatarImg: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#7079e3' },
  avatarText: { fontFamily: FONT.display, fontWeight: '800', fontSize: 19, color: C.heroInk },
  profileName: { fontFamily: FONT.body, fontSize: 16, fontWeight: '700', color: C.text },
  profileEmail: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 1 },

  group: { backgroundColor: C.card, borderWidth: 1, borderColor: C.hairline, borderRadius: 18, overflow: 'hidden', marginBottom: 18 },
  rowBase: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 15, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: C.hairline },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
  rowValue: { fontFamily: FONT.body, fontSize: 14, color: C.textDim },
  toggle: { width: 46, height: 28, borderRadius: 14, position: 'relative' },
  knob: { position: 'absolute', top: 3, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' },

  version: { textAlign: 'center', fontFamily: FONT.body, fontSize: 12, color: C.textFaintest, marginBottom: 6 },
});
