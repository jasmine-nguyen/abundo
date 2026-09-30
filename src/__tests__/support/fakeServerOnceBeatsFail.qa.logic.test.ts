// WHIT-660 QA — the two seams the moved insights/goal suites now lean on, driven through the
// REAL src/api.ts: a queued once() reply goes out ahead of a sticky fail() (insightsBreakdownQuery
// "sustained failure → Retry", insightsCycleToggle [A7], goalScreenData WHIT-121), and
// fetchBreakdown's query string (cycle 0 sends no cycle param; cycle > 0 appends &cycle=N).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';

const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

beforeEach(() => resetAuth());

describe('WHIT-660 QA — fake-server seams behind the moved suites', () => {
  const server = installFakeServer();

  // [A1] (P0) A queued reply beats a sticky failure, then the failure resumes.
  it('[A1] once() answers ahead of fail(), and the failure comes back after the queue drains', async () => {
    server.fail('/breakdown', 503);
    server.once('GET', '/breakdown', { body: BREAKDOWN });

    await expect(api.fetchBreakdown(14)).resolves.toEqual(BREAKDOWN);
    await expect(api.fetchBreakdown(14)).rejects.toThrow('API error: 503');
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(2);
  });

  // [A2] (P0) The exact query strings the moved suites assert on.
  it('[A2] cycle 0 sends ?days=N only; cycle 1 appends &cycle=1', async () => {
    server.seed('/breakdown', BREAKDOWN);

    await api.fetchBreakdown(14);
    await api.fetchBreakdown(30, 1);

    expect(server.sentUnder('GET', '/breakdown').map((request) => request.path)).toEqual([
      '/breakdown?days=14',
      '/breakdown?days=30&cycle=1',
    ]);
  });
});
