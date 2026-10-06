import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { C, FONT, tint } from '../theme';
import { Icon, Glyph } from '../icons';
import { categoryTreeRows } from '../context';
import type { Category } from '../types';
import { toggleIn, visibleTreeRows } from '../setutil';

// WHIT-273 / WHIT-796: the foldable parent→child category list both category pickers share.
// Empty `collapsed` = everything expanded, so a picker opens fully revealed (you're here to find a
// category fast). Returns bare rows (no ScrollView) so a caller can put its own rows above them.
export function CategoryTree({ categories, onPick, testIDs }: {
  categories: Category[];
  onPick: (id: string) => void;
  testIDs: { pick?: string; name?: string; togglePrefix: string };
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const visibleRows = visibleTreeRows(categoryTreeRows(categories), (row) => row.category.id, (id) => !collapsed.has(id));

  return (
    <>
      {visibleRows.map(({ category: c, depth, hasChildren }) => {
        const isCollapsed = collapsed.has(c.id);
        return (
          // Two sibling tap targets, never nested: the name (chip + label) picks the category;
          // the chevron folds its subs, so a fold tap can't also pick. The chevron shows only on
          // parents, so a chevron always means "tap to expand/collapse".
          <View
            key={c.id}
            style={[pickStyles.pickRow, depth > 0 && { marginLeft: depth * 18, borderLeftWidth: 2, borderLeftColor: c.color, paddingLeft: 11 }]}
          >
            <Pressable testID={testIDs.pick} onPress={() => onPick(c.id)} style={pickStyles.pickNameHit}>
              <View style={[pickStyles.pickChip, { backgroundColor: tint(c.color, 0.15) }]}>
                <Icon name={c.icon} size={19} color={c.color} />
              </View>
              <Text testID={testIDs.name} style={pickStyles.pickName}>{c.name}</Text>
            </Pressable>
            {hasChildren && (
              <Pressable
                testID={`${testIDs.togglePrefix}${c.id}`}
                onPress={() => setCollapsed((prev) => toggleIn(prev, c.id))}
                accessibilityRole="button"
                accessibilityState={{ expanded: !isCollapsed }}
                style={pickStyles.pickToggle}
              >
                <Glyph name={isCollapsed ? 'chevron' : 'chevronDown'} size={16} color={C.textFaint} />
              </Pressable>
            )}
          </View>
        );
      })}
    </>
  );
}

export const pickStyles = StyleSheet.create({
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 11 },
  pickNameHit: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 13 },
  pickToggle: { padding: 6 },
  pickChip: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  pickName: { flex: 1, fontFamily: FONT.body, fontSize: 15, fontWeight: '600', color: C.textBright },
});
