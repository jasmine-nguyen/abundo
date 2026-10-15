import React from 'react';
import { View, StyleSheet } from 'react-native';
import { C, FONT } from '../theme';
import { Icon } from '../icons';
import { useLargeText } from '../hooks/useLargeText';

// A list row's header: icon chip, name, sub-line and a right-hand block (the amount). At very large
// text it stacks (name, then sub-line, then the right block) instead of squeezing, so no word splits
// mid-word (WHIT-743). Shared by Budgets and Insights (ABU-63).
export function StackingRowHeader({ icon, color, chipBg, name, sub, right }: {
  icon: string; color: string; chipBg: string;
  name: React.ReactNode; sub?: React.ReactNode; right: React.ReactNode;
}) {
  const large = useLargeText();
  const chip = <View style={[styles.chip, { backgroundColor: chipBg }]}><Icon name={icon} size={23} color={color} /></View>;
  if (large) {
    return (
      <View>
        <View style={styles.nameLine}>
          {chip}
          <View style={styles.nameCol}>{name}</View>
        </View>
        <View style={styles.stackBody}>
          {sub}
          <View style={styles.stackRight}>{right}</View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.line}>
      {chip}
      <View style={styles.nameCol}>
        {name}
        {sub}
      </View>
      <View style={styles.right}>{right}</View>
    </View>
  );
}

export const rowTextStyles = StyleSheet.create({
  name: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600', color: C.textBright, letterSpacing: -0.2 },
  sub: { fontFamily: FONT.body, fontSize: 13, color: C.textDim, marginTop: 2 },
});

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: 13 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  nameCol: { flex: 1, minWidth: 0 },
  right: { alignItems: 'flex-end', maxWidth: '45%' },
  stackBody: { marginTop: 6 },
  stackRight: { marginTop: 6 },
  chip: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
