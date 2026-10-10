// WHIT-501 — the useUncategorizedCount hook itself, against a REAL QueryClient (the real ../api over
// the fake server, ../auth mocked): no whole-history walk fires unless the session is authed
// (enabled = useIsAuthed()), and the hook stays `undefined` so consumers fall back to the local count.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';
import { makeClient, wrapper } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth, setAuthStatusQuietly } from './support/authMock';

import { useUncategorizedCount } from '../queries';

const server = installFakeServer();
const COUNT_PATH = '/transactions/uncategorized/count';

beforeEach(() => {
  resetAuth();
  server.seed(COUNT_PATH, { count: 4 });
});

// Fail-on-revert: hard-wire the query `enabled: true` (drop useIsAuthed) → the walk fires and this fails.
it.each(['anon', 'locked'] as const)('does NOT fetch while the session is %s', (status) => {
  setAuthStatusQuietly(status);
  const { result } = renderHook(() => useUncategorizedCount(), { wrapper: wrapper(makeClient({ staleTime: 0 })) });
  expect(server.sent('GET', COUNT_PATH)).toHaveLength(0);
  expect(result.current).toBeUndefined(); // → undefined, so consumers fall back to local
});
