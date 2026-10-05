// WHIT-700 — the Insights header's Export button shares the cycle the switch shows.
// Runs on the shared Insights kit (real ../api over the fake server); the file + share step
// (../cycleShare) is mocked, as it's the native boundary.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent, waitFor, act } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedInsights, renderInsights, resetAi } from './support/insightsScreen';
import { shareCycleExport } from '../cycleShare';
import { COFFEE } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());
jest.mock('../cycleShare', () => ({ shareCycleExport: jest.fn() }));

const share = shareCycleExport as jest.MockedFunction<typeof shareCycleExport>;
const server = installFakeServer();
useTestQueryClient();

const CATS = [{ ...COFFEE, recent: 0 }];

beforeEach(() => {
  resetAuth();
  resetAi();
  share.mockReset();
  share.mockResolvedValue(undefined);
  seedInsights(server, { breakdown: { coffee: { posted: 40, pending: 10 } }, categories: CATS });
});

it('user can export this cycle, then last cycle, from the Insights header', async () => {
  await renderInsights();
  await screen.findByText('Cafes & Coffee');

  fireEvent.press(screen.getByTestId('insights-export'));
  await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
  expect(share.mock.calls[0][0]).toBe(0);
  expect(share.mock.calls[0][1]('coffee')?.name).toBe('Cafes & Coffee');
  await screen.findByText('Export');

  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  await screen.findByText('LAST PAY CYCLE');
  fireEvent.press(screen.getByTestId('insights-export'));
  await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
  expect(share.mock.calls[1][0]).toBe(1);
});

it('a second tap while an export is running does not start another', async () => {
  let finish: () => void = () => {};
  share.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await renderInsights();
  await screen.findByText('Cafes & Coffee');

  fireEvent.press(screen.getByTestId('insights-export'));
  fireEvent.press(screen.getByTestId('insights-export'));
  await waitFor(() => expect(screen.queryByText('Export')).toBeNull());
  fireEvent.press(screen.getByTestId('insights-export'));
  expect(share).toHaveBeenCalledTimes(1);

  await act(async () => finish());
  await screen.findByText('Export');
});

it('a failed export shows an error alert', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  share.mockRejectedValue(new Error('network'));
  await renderInsights();
  await screen.findByText('Cafes & Coffee');

  fireEvent.press(screen.getByTestId('insights-export'));
  await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't export", 'Please try again.'));
  alert.mockRestore();
});
