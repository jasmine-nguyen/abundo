// WHIT-771 QA — Goals dropped its drifted 11/24 Retry copy; the error Retry is now the shared 10/22 chip.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { renderWithQueries, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { pinToday } from './support/clock';
import { seedHubWith } from './support/goalsScreen';

jest.mock('../motion/ScrollChromeHeader', () => require('./support/scrollChromeHeaderMock').scrollChromeHeaderMockModule());
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Goals from '../../app/(tabs)/goals';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetAuth();
  resetRouter();
  pinToday(new Date(2026, 6, 11));
  seedHubWith(server, {});
});

it('[A3] a failed Goals read → Retry is the shared 10/22 chip, not the old 11/24', async () => {
  server.fail('/paycycle', 500);
  await renderWithQueries(<Goals />);
  const button = StyleSheet.flatten(screen.getByTestId('goals-retry').props.style);
  expect(button).toMatchObject({ paddingVertical: 10, paddingHorizontal: 22, borderRadius: 12 });
});
