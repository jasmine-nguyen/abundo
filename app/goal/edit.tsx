import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { C, FONT } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { Header } from '../../src/components/Header';

// WHIT-233: a placeholder for the goal add/edit form (built in WHIT-234). The Goals hub's
// "+" and each goal card route here, so the buttons don't dead-end — this shows a friendly
// "coming soon" with a working back button rather than a blank screen. `id` is present when
// editing an existing goal, absent when adding.
export default function GoalEdit() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = typeof id === 'string' && id.length > 0;

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 6 }}>
      <Header title={editing ? 'Edit goal' : 'Add a goal'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: insets.bottom + 40, flexGrow: 1 }} showsVerticalScrollIndicator={false}>
        <View testID="goal-edit-placeholder" style={styles.centered}>
          <View style={styles.chip}><Glyph name="target" size={26} color={C.accentSoft} /></View>
          <Text style={styles.title}>Coming soon</Text>
          <Text style={styles.body}>
            {editing
              ? 'Editing a goal lands here soon — for now, tap back to return to your goals.'
              : "Creating a goal lands here soon — for now, tap back to return to your goals."}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, gap: 6 },
  chip: { width: 56, height: 56, borderRadius: 17, backgroundColor: 'rgba(124,140,255,.14)', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontFamily: FONT.display, fontSize: 19, fontWeight: '800', color: C.textBright, letterSpacing: -0.3 },
  body: { fontFamily: FONT.body, fontSize: 13.5, color: C.textDim, lineHeight: 20, textAlign: 'center', marginTop: 4 },
});
