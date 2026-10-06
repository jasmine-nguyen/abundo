// WHIT-772 — the shared "nothing here yet" block used by Transactions, Accounts, account/[id]
// and category/[id]. Locks: title + sub copy, testID on the outer block, and the optional icon tile.
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

it('shows the title and sub with the testID, and no icon tile when no icon is given', () => {
  render(<EmptyState testID="account-empty" title="No transactions" sub="This account has no transactions yet." />);
  const block = screen.getByTestId('account-empty');
  expect(screen.getByText('No transactions')).toBeTruthy();
  expect(screen.getByText('This account has no transactions yet.')).toBeTruthy();
  expect(block.findAll((node) => node !== block && (node.type as string) === 'View')).toHaveLength(0);
});

it('shows the given icon inside a tile using the iconBackground override', () => {
  const query = 'coffee';
  render(
    <EmptyState
      testID="transactions-no-results"
      icon={<View testID="empty-icon" />}
      iconBackground="rgba(255,255,255,.06)"
      title="No matches"
      sub={<>No transactions match “{query}”.</>}
    />,
  );
  expect(screen.getByTestId('transactions-no-results')).toBeTruthy();
  expect(screen.getByText('No matches')).toBeTruthy();
  expect(screen.getByText('No transactions match “coffee”.')).toBeTruthy();
  expect(tileStyle()?.backgroundColor).toBe('rgba(255,255,255,.06)');
});

// Without an override the tile keeps the green tint every screen used ("All caught up",
// "No accounts yet", "More to load").
it('uses the default green tile behind an icon when no iconBackground is given', () => {
  render(<EmptyState testID="block" icon={<View testID="empty-icon" />} title="All caught up" sub="Done." />);
  expect(tileStyle()?.backgroundColor).toBe(tint(C.good, 0.12));
});
