import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { useAppContext, countUncategorized } from '../../src/context';

const TABS = [
  { name: 'budgets', label: 'Budgets', icon: 'navBudgets' },
  { name: 'transactions', label: 'Transactions', icon: 'navTx' },
  { name: 'insights', label: 'Insights', icon: 'navInsights' },
  { name: 'goals', label: 'Goal', icon: 'navGoals' },
  { name: 'settings', label: 'Settings', icon: 'navSettings' },
] as const;

type TabBarShape = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (e: { type: 'tabPress'; target: string; canPreventDefault: boolean }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
};

function TabBar({ state, navigation }: TabBarShape) {
  const insets = useSafeAreaInsets();
  const store = useAppContext();
  const hasUncategorized = countUncategorized(store) > 0;

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + 14 }]}>
      {state.routes.map((route, idx) => {
        const meta = TABS.find((t) => t.name === route.name);
        if (!meta) return null;
        const focused = state.index === idx;
        const color = focused ? C.accent : C.textFaint;
        return (
          <Pressable
            key={route.key}
            style={styles.item}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
          >
            <View>
              <Glyph name={meta.icon} size={24} color={color} />
              {meta.name === 'transactions' && hasUncategorized && <View style={styles.dot} />}
            </View>
            <Text style={[styles.label, { color }]} numberOfLines={1}>{meta.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.bg } }} tabBar={(props) => <TabBar {...(props as unknown as TabBarShape)} />}>
      <Tabs.Screen name="budgets" />
      <Tabs.Screen name="transactions" />
      <Tabs.Screen name="insights" />
      <Tabs.Screen name="goals" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: 10, paddingHorizontal: 8, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.hairline },
  // flex:1 (not a fixed width) so the items share the row evenly — with 5 tabs a
  // fixed 76pt width overflowed narrow phones (5×76 + padding > 390pt).
  item: { flex: 1, minWidth: 0, alignItems: 'center', gap: 5 },
  label: { fontFamily: FONT.body, fontSize: 10.5, fontWeight: '600' },
  dot: { position: 'absolute', top: -3, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: C.bad, borderWidth: 2, borderColor: C.bg },
});
