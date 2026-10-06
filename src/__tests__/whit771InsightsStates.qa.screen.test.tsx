// WHIT-771 QA — Insights now renders ListStates: 60px vertical room and the brighter 14.5 textMid
// copy, with the shared Retry chip. Retry still refetches the failed read.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { screen, fireEvent } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { resetRouter } from './support/routerMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';
import { C } from '../theme';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle' }];
const styleOf = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);

beforeEach(() => {
  resetRouter();
  resetAuth();
  resetAi();
});

describe('Insights error block matches the other tabs', () => {
  it('[A1] a failed read → 60px error area, 14.5 textMid copy and the shared 10/22 Retry chip', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 3000 }), categories: CATS });
    server.fail('/paycycle', 500);
    await renderInsights();
    expect(styleOf('insights-error')).toMatchObject({ paddingVertical: 60 });
    const copy = StyleSheet.flatten(screen.getByText("Couldn't load your spending.").props.style);
    expect(copy).toMatchObject({ fontSize: 14.5, color: C.textMid });
    expect(styleOf('insights-retry')).toMatchObject({ paddingVertical: 10, paddingHorizontal: 22 });
  });

  it('[A2] pressing Retry after the read recovers → error goes, spending shows', async () => {
    seedInsights(server, { breakdown: breakdownWire({ earned: 3000 }), categories: CATS });
    server.once('GET', '/paycycle', { status: 500 });
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    await refreshInAct(() => fireEvent.press(screen.getByTestId('insights-retry')));
    await settle();
    expect(screen.queryByTestId('insights-error')).toBeNull();
    expect(await screen.findByTestId('insights-earned-spent')).toBeTruthy();
  });
});
