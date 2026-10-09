// WHIT-833 QA — adversarial complements to useAiInsights.provider.screen.test.tsx: the AI coach
// card unmounting mid-analyse, a refresh racing "Analyse my spending", and no reads while signed out.
import React from 'react';
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, act, waitFor } from '@testing-library/react-native';
import * as api from '../api';
import { useAiInsights } from '../hooks/useAiInsights';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth, setAuthStatus, setAuthStatusQuietly } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { settle, useTestQueryClient } from './support/renderWithQueries';
import { WithApp } from './support/renderWithApp';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => { resetAuth(); });
afterEach(() => { jest.restoreAllMocks(); });

let latest!: ReturnType<typeof useAiInsights>;
function Probe() {
  latest = useAiInsights();
  return null;
}
// The Insights screen mounts the coach card only on the current cycle: `{cycle === 0 && <AiCoachCard />}`.
function Screen({ showCard }: { showCard: boolean }) {
  return <WithApp>{showCard && <Probe />}</WithApp>;
}

// [A1] The cycle toggle unmounts the coach card. Coming back while the paid analyse is still
// running must still show the spinner, or the user can tap "Analyse my spending" again.
it('the analyse spinner survives the coach card unmounting and remounting while the request runs', async () => {
  const view = render(<Screen showCard />);
  await settle();
  const held = server.hold('/insights/ai');
  server.once('POST', '/insights/ai', { body: { summary: 'fresh' } });
  act(() => { void latest.generate(null); });
  await waitFor(() => expect(latest.isLoading).toBe(true));

  view.rerender(<Screen showCard={false} />); // switch to last cycle
  view.rerender(<Screen showCard />); // back to this cycle, request still running

  expect(latest.isLoading).toBe(true);
  await act(async () => { held.release(); });
  await waitFor(() => expect(latest.insights?.summary).toBe('fresh'));
});

// [A2] A focus refresh still in flight when "Analyse my spending" answers must not overwrite the
// new summary with the older saved one when it lands late.
it('a refresh landing after a generate does not overwrite the generated summary', async () => {
  server.seed('/insights/ai', { summary: 'saved' });
  const fetchSpy = jest.spyOn(api, 'fetchAiInsights');
  render(<Screen showCard />);
  await waitFor(() => expect(latest.insights?.summary).toBe('saved'));

  let answerRefresh!: (value: api.AiInsights) => void;
  fetchSpy.mockImplementationOnce(() => new Promise((resolve) => { answerRefresh = resolve; }));
  act(() => { void latest.refresh(); });
  await waitFor(() => expect(answerRefresh).toBeDefined());

  server.once('POST', '/insights/ai', { body: { summary: 'generated' } });
  await act(async () => { await latest.generate(null); });
  await waitFor(() => expect(latest.insights?.summary).toBe('generated'));

  await act(async () => { answerRefresh({ summary: 'saved' } as api.AiInsights); });
  await settle();
  expect(latest.insights?.summary).toBe('generated');
});

// [A3] Signed out, the saved summary is not read; signing in reads it.
it('reads nothing while signed out, then reads the summary once signed in', async () => {
  setAuthStatusQuietly('anon');
  server.seed('/insights/ai', { summary: 'mine' });
  render(<Screen showCard />);
  await settle();
  expect(server.sent('GET', '/insights/ai')).toHaveLength(0);
  expect(latest.insights).toBeNull();

  act(() => { setAuthStatus('authed'); });
  await waitFor(() => expect(latest.insights?.summary).toBe('mine'));
});
