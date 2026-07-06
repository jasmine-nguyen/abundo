// WHIT-184 GAP — the Transactions segmented control ('All' / 'Uncategorized' / 'Accounts')
// gained a pressed dim (segPressed: opacity 0.6). Seg is a private component, so we render
// Transactions and pick the Seg Pressables by their distinctive segBtn geometry
// (paddingVertical 9 — a TransactionRow uses 13). Drop `pressed && styles.segPressed` and
// the opacity assertion fails.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import type { AppContext } from '../context';

const category = (_id: string | null) => undefined;
let mockTx: { transactions: unknown[]; category: typeof category; isLoading: boolean; isError: boolean; isFetching: boolean; refetch: jest.Mock; refetchStale: jest.Mock };
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});

jest.mock('expo-router', () => {
  const React2 = require('react');
  return { useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]) };
});

import Transactions from '../../app/(tabs)/transactions';

type Node = { props: { style: unknown } };

beforeEach(() => {
  mockTx = { transactions: [], category, isLoading: false, isError: false, isFetching: false, refetch: jest.fn(), refetchStale: jest.fn() };
  mockState = { retryLoad: jest.fn(), category } as unknown as AppContext;
});

function flat(node: Node, pressed: boolean) {
  return StyleSheet.flatten((node.props.style as (x: { pressed: boolean }) => unknown)({ pressed })) as { opacity?: number; paddingVertical?: number };
}

it('the three segmented tabs dim (opacity 0.6) on press and are solid at rest', () => {
  const { UNSAFE_root } = render(<Transactions />);
  const root = UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] };
  // Seg Pressables: function style whose resting flatten carries the segBtn paddingVertical 9.
  const segs = root.findAll((n) => typeof n.props?.style === 'function' && flat(n, false).paddingVertical === 9);
  expect(segs.length).toBe(3);
  for (const seg of segs) {
    expect(flat(seg, false).opacity).toBeUndefined();
    expect(flat(seg, true).opacity).toBe(0.6);
  }
});
