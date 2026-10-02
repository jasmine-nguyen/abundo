// WHIT-330 — GAP (Transactions screen): the surfaces the row/logic tests don't render.
//   [A-empty] a TRANSFERS-ONLY account no longer shows "All caught up" on the Uncategorized tab —
//             the transfer row is listed and the badge is non-zero (was empty/caught-up pre-330).
//   [A-file]  the transfer is now reachable + bulk-fileable FROM the Uncategorized tab in
//             selection mode — the only escape hatch for its grey, non-tappable row on that tab.
// The existing whit328SelectGap covers the ALL tab only (and its comment that the transfer is
// "NOT on the Uncategorized tab" is stale under WHIT-330 — see critique).
// WHIT-686: both screens run their real data code over the pretend server.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';

// WHIT-459 fold: superset useAppContext serving both regimes. The list screen asserts on
// openMultiPicker; the folded detail test asserts on openPicker and needs applyTransactionEdit
// + showToast present. Every key below is harmless to the screen that doesn't use it.
const mockOpenPicker = jest.fn();
const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openPicker: mockOpenPicker, openMultiPicker: mockOpenMultiPicker, applyTransactionEdit: jest.fn(), showToast: jest.fn() }) };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());

// WHIT-459 fold: superset expo-router — useFocusEffect (list screen) + useLocalSearchParams
// (detail screen deep-link to id 't1') + useRouter with back+push (union). Each screen ignores
// the hooks it doesn't call.
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return {
    useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]),
    useLocalSearchParams: () => ({ id: 't1' }),
    useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Transactions from '../../app/(tabs)/transactions';
import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct, WithQueries } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

// A not-in-budget uncategorized transfer: null category, counts_to_budget false.
const transfer = txn({
  transaction_id: 'xfer1', description: 'INTERNAL TRANSFER', merchant_name: 'Internal Transfer', amount: -500,
  account_name: 'ANZ', category: null, type: 'transfer', counts_to_budget: false,
});

beforeEach(() => {
  resetAuth();
  server.seed('/categories', []);
});

// The segmented control label 'Uncategorized' AND the transfer row's category label are both
// 'Uncategorized'; the seg renders first in tree order, so index [0] is the tab button.
const pressUncategorizedTab = () => fireEvent.press(screen.getAllByText('Uncategorized')[0]);

describe('WHIT-330 on the Transactions tab', () => {
  // The shop groups stay loading (as before this moved to the pretend server), so the
  // "File by shop" button never shows; released after each test.
  let merchants: { release: () => void };

  beforeEach(() => {
    mockOpenMultiPicker.mockClear();
    server.seed('/transactions/feed', { transactions: [transfer], nextCursor: null });
    server.seed('/transactions/uncategorized/feed', { transactions: [transfer], nextCursor: null });
    // The server's whole-history tally counts the transfer (WHIT-330).
    server.seed('/transactions/uncategorized/count', { count: 1 });
    merchants = server.hold('/transactions/uncategorized/merchants');
  });
  afterEach(async () => { await refreshInAct(() => merchants.release()); });

  async function openUncategorizedTab() {
    render(<WithQueries><Transactions /></WithQueries>);
    await screen.findByText('Internal Transfer');
    pressUncategorizedTab();
    await screen.findByText('Internal Transfer');
    expect(server.sentUnder('GET', '/transactions/uncategorized/feed')).toHaveLength(1);
  }

  // Fail-on-revert: restore the countUncategorized gate → uncategorizedCount 0 → "All caught up"
  // renders again → the first assertion fails.
  it('[A-empty] lists the transfer on the Uncategorized tab and hides the caught-up empty state', async () => {
    await openUncategorizedTab();
    expect(screen.queryByText('All caught up')).toBeNull();
    // The transfer row is present (merchant label is unique, unlike 'Uncategorized').
    expect(screen.getByText('Internal Transfer')).toBeTruthy();
  });

  // Fail-on-revert: restore the transactionGroups 'uncategorized' gate → the transfer is not
  // listed on this tab → getByLabelText('Select Internal Transfer') throws → this fails.
  it('[A-file] selection mode on the Uncategorized tab can hand the transfer to the picker', async () => {
    await openUncategorizedTab();
    fireEvent.press(screen.getByText('Select'));
    fireEvent.press(screen.getByLabelText('Select Internal Transfer'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
    expect(mockOpenMultiPicker).toHaveBeenCalledWith(['xfer1']);
  });
});

// ===== WHIT-328 (folded from whit328Gaps.screen.test.tsx) =====
// The DETAIL screen (a surface OTHER than the list row). WHIT-287 lets ANY charge be re-filed
// from the detail screen, so the single-tap list gate does NOT apply here.
describe('WHIT-328 — detail screen re-file for an uncategorized charge', () => {
  beforeEach(() => {
    mockOpenPicker.mockClear();
    server.seed('/categories', [{ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', parent: null }]);
    server.seed('/transactions/feed', {
      transactions: [txn({ transaction_id: 't1', category: null, counts_to_budget: false })],
      nextCursor: null,
    });
  });

  // [A-detail] The detail screen for a not-in-budget uncategorized charge still labels the Category
  // field "Uncategorized" and keeps it tappable — the re-file picker still opens. (Contrast the list
  // row, which is now quiet + non-tappable.) Documents the intentional divergence; see critique.
  it('detail screen labels the Category "Uncategorized" and re-opens the picker on tap', async () => {
    await renderWithQueries(<TransactionDetail />);
    expect(screen.getByText('Uncategorized')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Change category, currently Uncategorized'));
    expect(mockOpenPicker).toHaveBeenCalledWith('t1');
  });
});
