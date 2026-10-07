import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT } from '../theme';
import { HeaderIconButton } from './ui';

export function Header({
  title, right,
}: {
  title: string;
  right?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.side}>
          <HeaderIconButton icon="back" accessibilityLabel="Back" onPress={() => router.back()} />
        </View>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <View style={[styles.side, { alignItems: 'flex-end' }]}>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12, zIndex: 20 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40 },
  side: { minWidth: 40, height: 40, justifyContent: 'center' },
  title: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: C.textBright, letterSpacing: -0.2, flex: 1, textAlign: 'center' },
});
