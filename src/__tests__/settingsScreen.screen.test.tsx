// The Settings screen's Log out row and Account group, Back button and profile card, over the fake server: the real
// useSettingsScreenData / useRulesScreenData / usePayCycle read /categories, /loanfacts, /rules
// and /paycycle (server defaults). Folded from settingsLogout (WHIT-176, WHIT-495) and
// settingsProfile (WHIT-180).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, refreshInAct, settle, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { routerSpies, resetRouter, fireFocus } from './support/routerMock';
import { queryClient } from '../queryClient';
import { StyleSheet } from 'react-native';
import { hostsOfType } from './support/layout';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const mockSignOut = jest.fn(async () => {});
let mockUser: { email?: string; name?: string; picture?: string } | null = null;
jest.mock('../auth', () => ({
  ...require('./support/authMock').authMockModule(),
  signOut: () => mockSignOut(),
  getCurrentUser: () => mockUser,
}));

// The screen reads only setSheet off context; the selectors stay real.
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ setSheet: jest.fn() })));

import Settings from '../../app/settings';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  mockUser = null;
  resetRouter();
  mockSignOut.mockClear();
});

describe('Log out and Back', () => {
  // WHIT-176: Log out must END the session (signOut), not merely navigate. Fail-on-revert:
  // reverting to router.replace('/') alone drops the signOut() call.
  it('Log out calls signOut() and returns to the login screen', async () => {
    await renderWithQueries(<Settings />);
    await fireEvent.press(screen.getByTestId('settings-logout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith('/');
  });

  // WHIT-495: Settings is a pushed root screen, so it carries a Back control that pops the stack.
  it('renders a Back button that pops back to the origin tab', async () => {
    await renderWithQueries(<Settings />);
    await fireEvent.press(screen.getByLabelText('Back'));
    expect(routerSpies.back).toHaveBeenCalledTimes(1);
  });
});

// WHIT-180: the profile card shows the REAL signed-in identity (getCurrentUser), not the
// "Jordan Diaz" mock. Fail-on-revert: restoring the hard-coded mock fails these.
describe('profile card', () => {
  it('shows the real name + email (Google login), not the mock', async () => {
    mockUser = { email: 'me.jasminenguyen@gmail.com', name: 'Jasmine Nguyen' };
    await renderWithQueries(<Settings />);
    expect(screen.getByText('Jasmine Nguyen')).toBeTruthy();
    expect(screen.getByText('me.jasminenguyen@gmail.com')).toBeTruthy();
  });
});

// WHIT-753 QA [A3] — the shared router fake runs Settings' focus refresh (the old no-op
// useFocusEffect never did). A later focus on stale data re-reads the categories and loan facts.
// Fail-on-revert: drop the useFocusEffect line from app/settings.tsx and neither is re-read.
describe('focus refresh', () => {
  it('[A3] a later focus re-reads stale categories and loan facts', async () => {
    await renderWithQueries(<Settings />);
    const categoriesBefore = server.sent('GET', '/categories').length;
    const loanFactsBefore = server.sent('GET', '/loanfacts').length;
    await refreshInAct(() => queryClient.invalidateQueries({ refetchType: 'none' }));

    await refreshInAct(() => fireFocus());
    await settle();

    expect(server.sent('GET', '/categories').length).toBeGreaterThan(categoriesBefore);
    expect(server.sent('GET', '/loanfacts').length).toBeGreaterThan(loanFactsBefore);
  });
});

// ABU-119: on the unfolded Duo held sideways, the page content pads its sides by the left/right
// safe-area insets on top of its 18, so it sits clear of the status bar and rounded corners.
// Different left and right insets so a swap is caught.
it('pads the page content by the side safe-area insets (ABU-119)', async () => {
  const safeArea = require('react-native-safe-area-context');
  jest.spyOn(safeArea, 'useSafeAreaInsets').mockReturnValue({ top: 0, left: 44, right: 59, bottom: 0 });
  await renderWithQueries(<Settings />);
  const content = StyleSheet.flatten(hostsOfType('RCTScrollView')[0].props.contentContainerStyle);
  expect({ left: content.paddingLeft, right: content.paddingRight }).toEqual({ left: 62, right: 77 });
  jest.restoreAllMocks();
});
