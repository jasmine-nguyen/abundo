// WHIT-772 QA — the shared "nothing here yet" block must look exactly like the copies it replaced.
import { it, expect } from '@jest/globals';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { EmptyState } from '../components/EmptyState';
import { C, tint } from '../theme';

function tileStyle() {
  let node = screen.getByTestId('empty-icon').parent;
  while (node && !StyleSheet.flatten(node.props.style)?.backgroundColor) node = node.parent;
  return StyleSheet.flatten(node?.props.style);
}

// [A1] Without an override the tile keeps the green tint every screen used ("All caught up",
// "No accounts yet", "More to load").
it('uses the default green tile behind an icon when no iconBackground is given', () => {
  render(<EmptyState testID="block" icon={<View testID="empty-icon" />} title="All caught up" sub="Done." />);
  expect(tileStyle()).toMatchObject({ width: 64, height: 64, borderRadius: 20, backgroundColor: tint(C.good, 0.12) });
});

// [A3] The block, title and sub keep the old layout and type.
it('keeps the old block, title and sub styles', () => {
  render(<EmptyState testID="block" title="No transactions" sub="This account has no transactions yet." />);
  expect(StyleSheet.flatten(screen.getByTestId('block').props.style)).toMatchObject({ alignItems: 'center', paddingVertical: 64, paddingHorizontal: 30 });
  expect(StyleSheet.flatten(screen.getByText('No transactions').props.style)).toMatchObject({ fontSize: 18, fontWeight: '700', color: C.textBright });
  expect(StyleSheet.flatten(screen.getByText('This account has no transactions yet.').props.style)).toMatchObject({ fontSize: 13.5, color: C.textDim, marginTop: 6, textAlign: 'center', lineHeight: 20 });
});
