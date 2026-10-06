import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { C, FONT, tint } from '../theme';

// WHIT-772: the shared "nothing here yet" block — an optional icon tile, a bold title and a grey sub.
export function EmptyState({ title, sub, icon, iconBackground, testID }: {
  title: React.ReactNode;
  sub: React.ReactNode;
  icon?: React.ReactNode;
  iconBackground?: string;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.empty}>
      {icon != null && <View style={[styles.icon, iconBackground != null && { backgroundColor: iconBackground }]}>{icon}</View>}
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.sub}>{sub}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 },
  icon: { width: 64, height: 64, borderRadius: 20, backgroundColor: tint(C.good, 0.12), alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontFamily: FONT.display, fontSize: 18, fontWeight: '700', color: C.textBright },
  sub: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 },
});
