// WHIT-398 — [G5][G6] two SWEPT surfaces, rendered, pinned to the pre-token colour.
//
// The sweep rewrote 52 call sites; exactly one of them (the Insights cycle toggle) has a render-
// level colour assertion, in insightsSegmentedControl.gaps.screen.test.tsx [A10]/[A11]. These two
// are the shared components — the selected-row wash appears on Transactions AND budget detail, and
// the retry pill appears on transaction/[id] AND account/[id] — so one repaint here is visible on
// four screens.
//
// Both assert the RAW pre-token literal, matching the convention [A10] established: asserting
// against tint(C.accentAlt, a) would still pass if the token itself were repainted, which is the
// one regression these tests exist to catch. accentAltToken.logic.test.ts owns the token's value;
// these own "the component still asks for it".
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import { C } from '../theme';
import type { Category } from '../context';

let mockState: { openPicker: () => void; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

import { TransactionRow } from '../components/TransactionRow';
import { DetailStates } from '../components/DetailStates';

const CHIP_BLUE_10 = 'rgba(124,140,255,0.1)';  // was the literal 'rgba(124,140,255,.1)'
const CHIP_BLUE_16 = 'rgba(124,140,255,0.16)'; // was the literal 'rgba(124,140,255,.16)'

function rowState() {
  return { openPicker: jest.fn(), category: makeState({ categories: [cat({ id: 'coffee', name: 'Cafes & Coffee' })] }).category };
}
// The row's outer View carries styles.row + the selected wash and has no testID; it is the render
// root, so read it off the tree rather than inventing a testID for a colour assertion.
const rootStyle = (): { backgroundColor?: string; borderBottomColor?: string } =>
  StyleSheet.flatten((screen.toJSON() as unknown as { props: { style: unknown } }).props.style) as {
    backgroundColor?: string;
    borderBottomColor?: string;
  };

describe('[G5] the selected-transaction wash (TransactionRow.tsx:88, swept from rgba(124,140,255,.1))', () => {
  it('[G5] a selected row in selection mode paints the chip blue at 10%', () => {
    mockState = rowState();
    render(
      <TransactionRow
        t={txn({ merchant_name: 'Woolworths', category: 'coffee' })}
        category={mockState.category}
        selectable
        selected
      />,
    );
    expect(rootStyle().backgroundColor).toBe(CHIP_BLUE_10);
  });

  it('[G5] an UNselected row takes no wash — the tint is the selection signal, not the row', () => {
    mockState = rowState();
    render(
      <TransactionRow
        t={txn({ merchant_name: 'Woolworths', category: 'coffee' })}
        category={mockState.category}
        selectable
        selected={false}
      />,
    );
    const style = rootStyle();
    // anchored to a style only the row itself carries, so this can't pass by reading a wrapper
    expect(style.borderBottomColor).toBe(C.hairline);
    expect(style.backgroundColor).toBeUndefined();
  });
});

describe('[G6] the shared Retry pill (DetailStates.tsx:49, swept from rgba(124,140,255,.16))', () => {
  it('[G6] the error-state Retry button paints the chip blue at 16%', () => {
    render(
      <DetailStates
        isLoading={false}
        isError
        hasCache={false}
        idPrefix="thing"
        errorText="Couldn't load it."
        retryLabel="Retry loading it"
        onRetry={jest.fn()}
      >
        <Text testID="thing-content">loaded</Text>
      </DetailStates>,
    );
    const retry = StyleSheet.flatten(screen.getByTestId('thing-retry').props.style) as { backgroundColor?: string };
    expect(retry.backgroundColor).toBe(CHIP_BLUE_16);
  });
});
