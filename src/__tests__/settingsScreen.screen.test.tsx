// The Settings screen's Log out row, Back button and profile card, over the fake server: the real
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

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const mockSignOut = jest.fn(async () => {});
let mockUser: { email?: string; name?: string; picture?: string } | null = null;
jest.mock('../auth', () => ({
  ...require('./support/authMock').authMockModule(),
  signOut: () => mockSignOut(),
  getCurrentUser: () => mockUser,
}));

// The screen reads only setSheet off context; the selectors stay real.
jest.mock('../context', () => ({
  ...(jest.requireActual('../context') as object),
  useAppContext: () => ({ setSheet: jest.fn() }),
}));

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
    fireEvent.press(screen.getByTestId('settings-logout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith('/');
  });

  // WHIT-495: Settings is a pushed root screen, so it carries a Back control that pops the stack.
  it('renders a Back button that pops back to the origin tab', async () => {
    await renderWithQueries(<Settings />);
    fireEvent.press(screen.getByLabelText('Back'));
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
    expect(screen.queryByText('Jordan Diaz')).toBeNull();
    expect(screen.queryByText('jordan@abundo.app')).toBeNull();
  });

  it('shows just the email when there is no name (native password user)', async () => {
    mockUser = { email: 'me.jasminenguyen@gmail.com' };
    await renderWithQueries(<Settings />);
    expect(screen.getByText('me.jasminenguyen@gmail.com')).toBeTruthy();
    expect(screen.queryByText('Jordan Diaz')).toBeNull();
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

  // [A4] The shared spies are cleared between tests: an earlier Back / Log out leaves no calls here.
  it('[A4] starts each test with no router calls carried over', async () => {
    await renderWithQueries(<Settings />);
    expect(routerSpies.back).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });
});
