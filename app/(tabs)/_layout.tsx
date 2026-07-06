import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, LayoutChangeEvent } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, FONT } from '../../src/theme';
import { Glyph } from '../../src/icons';
import { useAppContext, countUncategorized } from '../../src/context';
import { NavBarsProvider, useNavBars } from '../../src/motion/NavBarsContext';
import { NavBarsRouteReset } from '../../src/motion/NavBarsRouteReset';
import { useReduceMotion } from '../../src/motion/useReduceMotion';

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
  // Scroll-to-hide (WHIT-184): the bar floats (position:absolute, so the scene fills
  // full height and content scrolls under it), and slides straight down out of view
  // when `visibility` → 0. Measure the bar's own height so the hidden state translates
  // it exactly off-screen regardless of safe-area inset. Reset-to-shown lives in
  // NavBarsRouteReset (one owner), so the bar isn't involved in that anymore.
  const { visibility } = useNavBars();
  const [barHeight, setBarHeight] = useState(90);
  const onLayout = (e: LayoutChangeEvent) => setBarHeight(e.nativeEvent.layout.height);
  const translateY = visibility.interpolate({ inputRange: [0, 1], outputRange: [barHeight, 0] });

  return (
    <Animated.View onLayout={onLayout} style={[styles.bar, { paddingBottom: insets.bottom + 14, transform: [{ translateY }] }]}>
      {state.routes.map((route, idx) => {
        const meta = TABS.find((t) => t.name === route.name);
        if (!meta) return null;
        const focused = state.index === idx;
        const color = focused ? C.accent : C.textFaint;
        return (
          <Pressable
            key={route.key}
            // Press feedback (WHIT-184 taste): instant dim + slight shrink on tap so a
            // tab doesn't feel dead. Pure visual — no animation lib, no data path.
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
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
    </Animated.View>
  );
}

export default function TabsLayout() {
  // reduce-motion owns two things here: the native tab-switch animation, and (passed
  // down) the scroll-to-hide nav-bars tween. Both fall back to instant when it's on.
  const reduceMotion = useReduceMotion();
  return (
    <NavBarsProvider reduceMotion={reduceMotion}>
      {/* Single owner of "reset bars to shown" — fires on any route change (tab switch
          or a detail push/pop). Must sit inside the provider AND the navigator. */}
      <NavBarsRouteReset />
      <Tabs
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: C.bg },
          // Tab-switch transition (WHIT-184): a light cross-fade instead of a hard cut,
          // off when the user asked for reduced motion.
          animation: reduceMotion ? 'none' : 'fade',
        }}
        tabBar={(props) => <TabBar {...(props as unknown as TabBarShape)} />}
      >
        <Tabs.Screen name="budgets" />
        <Tabs.Screen name="transactions" />
        <Tabs.Screen name="insights" />
        <Tabs.Screen name="goals" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </NavBarsProvider>
  );
}

const styles = StyleSheet.create({
  // Floats over the scene (absolute) so the list reclaims the space when the bar hides.
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', paddingTop: 10, paddingHorizontal: 8, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.hairline },
  // flex:1 (not a fixed width) so the items share the row evenly — with 5 tabs a
  // fixed 76pt width overflowed narrow phones (5×76 + padding > 390pt).
  item: { flex: 1, minWidth: 0, alignItems: 'center', gap: 5 },
  // WHIT-184 taste: pressed-state feedback for the tab buttons.
  itemPressed: { opacity: 0.55, transform: [{ scale: 0.92 }] },
  label: { fontFamily: FONT.body, fontSize: 10.5, fontWeight: '600' },
  dot: { position: 'absolute', top: -3, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: C.bad, borderWidth: 2, borderColor: C.bg },
});
