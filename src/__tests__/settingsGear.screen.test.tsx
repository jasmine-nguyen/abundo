// WHIT-495 — the Settings tab became a header gear (top-left) on all five tabs, pushing the
// /settings route. This locks three things the DoD demands:
//   1. The gear is an accessible "Settings" button with a 44x44 touch area, and tapping it
//      navigates to /settings.
//   2. In the shared header the gear renders BEFORE the title (so it's first in the VoiceOver
//      focus order and reads as an action, not part of the title).
//   3. The gear is actually present on ALL FIVE remaining tabs — so a dropped `left` prop on any
//      one screen fails here rather than shipping silently.
import { it, expect, jest, describe, beforeEach } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React2 = require('react');
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (cb: () => void) => React2.useEffect(() => cb(), [cb]),
    useIsFocused: () => true,
  };
});

// Real ScrollChromeHeader, but stub its geometry hook so it renders without a NavBarsProvider.
// The header still renders left → title → right in JSX order.
jest.mock('../motion/useNavBarsHeader', () => ({
  HEADER_BODY_HEIGHT: 58,
  TAB_BAR_CLEARANCE: 120,
  floatingHeaderStyle: {},
  useNavBarsHeader: () => ({
    onScroll: jest.fn(), scrollEventThrottle: 16, headerStyle: {},
    headerHeight: 58, headerPaddingTop: 6, statusBarHeight: 0, contentPadding: { paddingTop: 58, paddingBottom: 120 },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// Real selectors (budgetViews / transactionGroups / accountSummaries / categoryBreakdown / …),
// benign useAppContext covering every slice the five screens read.
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      openMultiPicker: jest.fn(), showToast: jest.fn(), openGoalBalance: jest.fn(),
      setSheet: jest.fn(), rules: [], cycleName: () => 'Fortnightly',
      aiInsights: null, aiInsightsError: false, aiInsightsLoading: false, refreshAiInsights: jest.fn(),
    }),
  };
});

import { SettingsButton } from '../components/SettingsButton';
import { ScrollChromeHeader } from '../motion/ScrollChromeHeader';
import Budgets from '../../app/(tabs)/budgets';
import Transactions from '../../app/(tabs)/transactions';
import Accounts from '../../app/(tabs)/accounts';
import Insights from '../../app/(tabs)/insights';
import Goals from '../../app/(tabs)/goals';

// Every tab reads the server defaults (empty lists, a zero uncategorized count).
installFakeServer();
useTestQueryClient();

beforeEach(() => {
  mockPush.mockClear();
  resetAuth();
});

describe('SettingsButton (the header gear)', () => {
  it('is an accessible "Settings" button and navigates to /settings on press', () => {
    render(<SettingsButton />);
    const btn = screen.getByLabelText('Settings');
    expect(btn.props.accessibilityRole).toBe('button');
    fireEvent.press(btn);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('pads the touch target past the 44x44 minimum (hitSlop, not a scaled glyph)', () => {
    render(<SettingsButton />);
    // 40x40 visual + hitSlop 8 on each side = 56x56 touchable, clears the 44x44 floor.
    expect(screen.getByLabelText('Settings').props.hitSlop).toBe(8);
  });
});

it('renders the gear BEFORE the title in the shared header (VoiceOver focus order)', () => {
  const tree = render(
    <ScrollChromeHeader title="TITLE_MARKER" left={<Text>GEAR_MARKER</Text>}>
      <Text>body</Text>
    </ScrollChromeHeader>,
  );
  const serialized = JSON.stringify(tree.toJSON());
  expect(serialized.indexOf('GEAR_MARKER')).toBeGreaterThanOrEqual(0);
  expect(serialized.indexOf('GEAR_MARKER')).toBeLessThan(serialized.indexOf('TITLE_MARKER'));
});

// The whole point of the ticket: the gear must be on EVERY remaining tab. A dropped `left` on any
// one screen makes that screen's case fail here.
describe.each([
  ['Budgets', <Budgets />],
  ['Transactions', <Transactions />],
  ['Accounts', <Accounts />],
  ['Insights', <Insights />],
  ['Goals', <Goals />],
] as [string, React.ReactElement][])('the Settings gear is present on %s', (_name, ui) => {
  it('renders a "Settings" header button that opens /settings', async () => {
    await renderWithQueries(ui);
    const btn = screen.getByLabelText('Settings');
    fireEvent.press(btn);
    expect(mockPush).toHaveBeenCalledWith('/settings');
  });
});
