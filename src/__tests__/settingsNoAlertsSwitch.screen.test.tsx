// WHIT-795: the "Pending alerts" switch did nothing (never saved, never read), so it's removed.
// The group below Setup is now headed "Account" and holds only Log out.
import { describe, it, expect, jest } from '@jest/globals';
import React from 'react';
import { screen, within } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../auth', () => ({ ...require('./support/authMock').authMockModule(), getCurrentUser: () => null }));
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({ setSheet: jest.fn() })));

import Settings from '../../app/settings';

installFakeServer();
useTestQueryClient();

describe('Settings without the alerts switch', () => {
  it('shows no "Pending alerts" row; the Account group holds Log out', async () => {
    await renderWithQueries(<Settings />);

    expect(screen.queryByText('Pending alerts')).toBeNull();
    expect(screen.queryByText('PREFERENCES')).toBeNull();
    expect(screen.getByText('ACCOUNT')).toBeTruthy();
    expect(within(screen.getByTestId('settings-logout')).getByText('Log out')).toBeTruthy();
  });
});
