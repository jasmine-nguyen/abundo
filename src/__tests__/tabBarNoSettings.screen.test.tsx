// WHIT-495 — GAP: the Settings tab became a header gear, so the bottom bar must render EXACTLY
// the five remaining tabs and NEVER a "Settings" item. tabsScreenOrder locks the <Tabs.Screen>
// NAVIGATOR declarations; this instead locks the `TABS` metadata that drives the rendered bar.
// We pass a route set that STILL includes a `settings` route (as react-navigation would if the
// screen were re-added): the bar must skip it because `TABS` has no settings entry.
// Fail-on-revert: re-add `{ name: 'settings', label: 'Settings', icon: 'navSettings' }` to TABS
// → the passed settings route now renders a "Settings" tab → this goes RED.
import { it, expect, jest } from '@jest/globals';
import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('../queries', () => ({
  useRecentTransactionsScreenData: () => ({ transactions: [], category: () => undefined }),
  useKeepTransactionsFeedWarm: () => {},
  // WHIT-501: leave the server tally undefined so the dot falls back to the LOCAL recent-window count.
  useUncategorizedCount: () => undefined,
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../motion/NavBarsContext', () => ({ useNavBars: () => ({ visibility: { interpolate: () => 0 } }) }));
jest.mock('expo-router', () => ({ Tabs: Object.assign(() => null, { Screen: () => null }) }));

import { TabBar } from '../../app/(tabs)/_layout';

// Full navigator route set WITH a stray `settings` route appended — the exact thing that would
// leak a Settings tab back if TABS regained its entry.
const barProps: React.ComponentProps<typeof TabBar> = {
  state: {
    index: 0,
    routes: [
      { key: 'budgets', name: 'budgets' },
      { key: 'transactions', name: 'transactions' },
      { key: 'accounts', name: 'accounts' },
      { key: 'insights', name: 'insights' },
      { key: 'goals', name: 'goals' },
      { key: 'settings', name: 'settings' },
    ],
  },
  navigation: { emit: () => ({ defaultPrevented: false }), navigate: jest.fn() },
};

it('renders the five remaining tabs and never a Settings tab, even when a settings route is present', () => {
  render(<TabBar {...barProps} />);
  for (const label of ['Budgets', 'Transactions', 'Accounts', 'Insights', 'Goals']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText('Settings')).toBeNull();
});
