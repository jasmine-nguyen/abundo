import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { C, FONT } from '../theme';
import { Glyph } from '../icons';

export function Header({
  title, showBack = true, right,
}: {
  title: string;
  showBack?: boolean;
  right?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.side}>
          {showBack && (
            <Pressable onPress={() => router.back()} style={styles.iconBtn}>
              <Glyph name="back" size={22} color="#fff" />
            </Pressable>
          )}
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
  iconBtn: { width: 40, height: 40, backgroundColor: 'rgba(255,255,255,.06)', borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: FONT.display, fontWeight: '700', fontSize: 19, color: '#fff', letterSpacing: -0.2, flex: 1, textAlign: 'center' },
});
