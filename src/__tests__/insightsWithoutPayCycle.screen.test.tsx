// WHIT-840 — Insights doesn't use the pay cycle, so a pay-cycle failure must not blank it.
// Real ../api over the fake server, ../auth mocked; a real QueryClientProvider drives the hook.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { useInsightsScreenData } from '../queries';
import { COFFEE } from './support/categories';

const server = installFakeServer();

beforeEach(() => {
  server.seed('/breakdown', { coffee: { posted: 40, pending: 10 } });
  server.seed('/categories', [{ ...COFFEE }]);
  server.seed('/budgets', {});
});

it('Insights loads its spending when the pay cycle fails', async () => {
  server.fail('/paycycle', 503);
  const { result } = renderHook(() => useInsightsScreenData(), { wrapper: wrapper(makeClient()) });

  await waitFor(() => expect(result.current.category('coffee')?.name).toBe('Cafes & Coffee'));
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  expect(result.current.isError).toBe(false);
  expect(result.current.breakdown.coffee).toEqual({ posted: 40, pending: 10 });
  expect(server.sent('GET', '/breakdown')).toHaveLength(1);
  expect(server.sent('GET', '/paycycle')).toHaveLength(0);
});
