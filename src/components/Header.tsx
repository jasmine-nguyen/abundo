import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT } from '../theme';
import { HeaderIconButton } from './ui';
import { TITLE_MAX_SCALE } from '../hooks/useLargeText';

export function Header({
  title, right, divider,
}: {
  title: string;
  right?: React.ReactNode;
  divider?: boolean;
}) {
  const router = useRouter();
  return (
    <View testID="header-wrap" style={[styles.wrap, divider && styles.divider]}>
      <View style={styles.row}>
        <View style={styles.side}>
          <HeaderIconButton icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        </View>
        <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={TITLE_MAX_SCALE}>{title}</Text>
        <View style={[styles.side, { alignItems: 'flex-end' }]}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The edge is always drawn (transparent at the top), so showing it never shifts the page.
  wrap: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12, zIndex: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'transparent' },
  divider: { borderBottomColor: C.hairline },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  side: { minWidth: 40, height: 40, justifyContent: 'center' },
  title: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: C.textBright, letterSpacing: -0.2, flex: 1, textAlign: 'center' },
});
