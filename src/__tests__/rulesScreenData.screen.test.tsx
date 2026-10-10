// WHIT-195 — the Rules screen's composite on the REAL query layer: not fetched before
// login, fires on the auth flip. Real ../api over the fake server, ../auth mocked; real
// QueryClientProvider.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

import { useRulesScreenData } from '../queries';

const server = installFakeServer();
const ruleRequests = () => server.sent('GET', '/rules');

const SERVER = [{ id: 'e1', field: 'description', operator: 'contains', value: 'NETFLIX', categoryId: 'subs' }];

beforeEach(() => {
  resetAuth();
  server.seed('/rules', SERVER);
});

it('does not fetch before login, then fires on the auth flip to authed', async () => {
  setAuthStatusQuietly('anon');
  const { result } = renderHook(() => useRulesScreenData(), { wrapper: wrapper(makeClient()) });
  expect(ruleRequests()).toHaveLength(0);

  await act(async () => { setAuthStatus('authed'); });
  await waitFor(() => expect(result.current.rules).toHaveLength(1));
  expect(ruleRequests().length).toBeGreaterThan(0);
});
