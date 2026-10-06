// WHIT-772 — the shared "nothing here yet" block used by Transactions, Accounts, account/[id]
// and category/[id]. Locks: title + sub copy, testID on the outer block, and the optional icon tile.
import { it, expect } from '@jest/globals';
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { EmptyState } from '../components/EmptyState';

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
  const tileBackgrounds: unknown[] = [];
  for (let node = screen.getByTestId('empty-icon').parent; node; node = node.parent) {
    if (node.props.testID === 'transactions-no-results') break;
    tileBackgrounds.push(StyleSheet.flatten(node.props.style)?.backgroundColor);
  }
  expect(tileBackgrounds).toContain('rgba(255,255,255,.06)');
});
