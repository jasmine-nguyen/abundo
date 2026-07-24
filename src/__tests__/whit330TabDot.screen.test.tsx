// WHIT-330 — GAP: the tab-bar red dot is driven by countUncategorized, which now counts
// transfers. The existing tabBadgeQuery.screen.test only covers a budget-COUNTING uncategorized
// charge; this locks the new case the card called out — a TRANSFERS-ONLY account (every unfiled
// charge is a not-in-budget transfer) now lights the dot where pre-330 it stayed dark.
// Fail-on-revert: restore the `contributesToBudget(t) &&` gate in countUncategorized → this
// account counts 0 → no dot → this fails.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { txn } from './factory';

let mockTx: { transactions: unknown[]; category: (id: string | null) => unknown };
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));

import { TabBar } from '../../app/(tabs)/_layout';

const barProps: React.ComponentProps<typeof TabBar> = {
  state: { index: 0, routes: [{ key: 'transactions', name: 'transactions' }] },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('lights the tab dot when the only unfiled charge is a not-in-budget transfer (WHIT-330)', () => {
  // category:null resolves to uncategorized; counts_to_budget:false = a transfer (not-in-budget).
  mockTx = { transactions: [txn({ transaction_id: 'xfer', category: null, counts_to_budget: false })], category: (_id: string | null) => undefined };
  render(<TabBar {...barProps} />);
  expect(screen.getByTestId('tab-uncat-dot')).toBeTruthy();
});
