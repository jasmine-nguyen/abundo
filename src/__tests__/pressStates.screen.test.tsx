// WHIT-184 GAP — the "visible press state" DoD on the TransactionRow, which the
// implementer's TransactionRow.screen.test.tsx (labels + tap-to-open) never asserts. The row
// now uses style={({pressed}) => [styles.row, pressed && styles.rowPressed]}. We call that
// style function with pressed true/false and flatten it: a revert that drops the pressed
// branch (row feels dead again) fails here. Also guards that a NON-tappable row is disabled,
// so it can never enter the pressed/dim state.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import type { Category } from '../context';

// WHIT-192: the row reads only openPicker from the store; category is a prop.
let mockState: { openPicker: jest.Mock; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

import { TransactionRow } from '../components/TransactionRow';

type Node = { props: { style: unknown; disabled?: boolean; onPress?: unknown } };

beforeEach(() => {
  mockState = { openPicker: jest.fn(), category: makeState({ categories: [cat({ id: 'coffee' })] }).category };
});

// The row's Pressable is the only node whose `style` is a function (the pressed-state fn).
function pressable(root: { findAll: (p: (n: Node) => boolean) => Node[] }): Node {
  const hits = root.findAll((n) => typeof n.props?.style === 'function');
  expect(hits.length).toBe(1);
  return hits[0];
}
function flat(node: Node, pressed: boolean) {
  return StyleSheet.flatten((node.props.style as (x: { pressed: boolean }) => unknown)({ pressed })) as { opacity?: number };
}

it('a tappable row dims (opacity 0.6) on press and is solid at rest', () => {
  const { UNSAFE_root } = render(<TransactionRow t={txn({ transaction_id: 'tx9', category: null })} category={mockState.category} />);
  const row = pressable(UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] });
  expect(row.props.disabled).toBeFalsy();          // tappable → can enter pressed state
  expect(flat(row, false).opacity).toBeUndefined(); // at rest: no dim
  expect(flat(row, true).opacity).toBe(0.6);        // pressed: dim
});

it('a non-tappable (categorized) row is disabled, so it never dims', () => {
  const { UNSAFE_root } = render(<TransactionRow t={txn({ transaction_id: 'tx1', category: 'coffee' })} category={mockState.category} />);
  const row = pressable(UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] });
  expect(row.props.disabled).toBe(true);
  expect(row.props.onPress).toBeUndefined();
});
