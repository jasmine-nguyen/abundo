// WHIT-552 — the useUncategorizedMerchants hook itself, against a REAL QueryClient (the real ../api
// over the fake server, ../auth mocked): auth still gates the whole-history walk, even with enabled=true.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

import type { UncategorizedMerchants } from '../api';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth, setAuthStatusQuietly } from './support/authMock';

import { useUncategorizedMerchants } from '../queries';

const server = installFakeServer();
const MERCHANTS_PATH = '/transactions/uncategorized/merchants';
const merchantRequests = () => server.sent('GET', MERCHANTS_PATH);

const payload: UncategorizedMerchants = {
  unfiled: 3,
  groups: [{ merchant: 'Woolworths', rulePattern: 'WOOLWORTHS', groupedBy: 'merchant', count: 3,
    samples: ['WOOLWORTHS 123'], firstDate: '2026-07-01', lastDate: '2026-07-10', alsoCatches: [] }],
  ungrouped: { count: 0, samples: [] },
};

beforeEach(() => {
  resetAuth();
  server.seed(MERCHANTS_PATH, payload);
});

// [M1] auth still required — the backlog gate is additive, not a replacement.
it('does NOT fetch while signed out, even with enabled=true', () => {
  setAuthStatusQuietly('anon');
  const { result } = renderHook(() => useUncategorizedMerchants(true), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
  expect(merchantRequests()).toHaveLength(0);
  expect(result.current.merchants).toBeUndefined();
});
