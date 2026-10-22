// WHIT-189 — the Insights breakdown on the real query layer. Proves the migration's
// behaviours: breakdown comes from the auth-gated query (not fetched before login),
// windows on the real cycle length, a transient 5xx self-heals, a sustained failure
// shows an inline Retry — and crucially the breakdown failure is scoped to Insights.
// Real ../api over the fake server; ../auth + expo-router mocked; ../context PARTIALLY mocked
// (real selectors, stubbed useAppContext for the AI card) so ../queries' real imports still resolve.
//
// WHIT-467 folded in the WHIT-189 GAPS suite (qa's adversarial half — partial failure,
// focus-refetch storm, authed→locked mid-session) that carried a byte-identical mock map
// + timer/setup regime. Those three describe blocks sit at the end of the file.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeClient, pause } from './support/queryClient';
import { installFakeServer } from './support/fakeServer';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { setAuthStatus, setAuthStatusQuietly, resetAuth } from './support/authMock';

// The shared AI actions are single stable fns (as the real context's useCallbacks are), so the
// stub itself never rebuilds the screen's focus callback.
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
import { resetAi, refreshAiInsights } from './support/insightsScreen';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Insights from '../../app/(tabs)/insights';
import { UNCATEGORIZED_KEY } from '../model';
import { COFFEE } from './support/categories';

const server = installFakeServer();

const PAY_CYCLE = { length: 30, last_pay_date: '2026-07-01' };
const CATS = [{ ...COFFEE }];
const BREAKDOWN = { coffee: { posted: 40, pending: 10 } };

function renderInsights(client = makeClient()) {
  return render(React.createElement(QueryClientProvider, { client }, React.createElement(Insights)));
}

beforeEach(() => {
  resetAuth();
  resetAi();
  server.seed('/breakdown', BREAKDOWN);
  server.seed('/categories', CATS);
  server.seed('/paycycle', PAY_CYCLE);
});

it('does not fetch breakdown before login, then fires when auth flips to authed', async () => {
  setAuthStatusQuietly('anon');
  await renderInsights();
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(0);
  expect(server.sent('GET', '/paycycle')).toHaveLength(0);

  await act(async () => {
    setAuthStatus('authed');
  });
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(1);
});

it('a transient 5xx on breakdown retries and self-heals — no error shown', async () => {
  server.once('GET', '/breakdown', { status: 503 });
  await renderInsights(makeClient({ retry: 2 }));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.queryByTestId('insights-error')).toBeNull();
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(2);
});

it('a sustained breakdown failure sends a bounded number of requests (WHIT-668)', async () => {
  // The focus refresh used to re-run on every redraw; an errored read with nothing saved is always
  // out of date, so each failure asked again straight away (about 20 requests in 200ms here).
  server.fail('/breakdown', 503);
  await renderInsights(makeClient());
  expect(await screen.findByTestId('insights-error')).toBeTruthy();
  await pause(200);
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(1);

  server.once('GET', '/breakdown', { body: BREAKDOWN }); // a queued reply goes out ahead of the failure
  await fireEvent.press(screen.getByTestId('insights-retry'));
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(2);
});

it('the AI summary read fires once per focus, not on every redraw (WHIT-668)', async () => {
  await renderInsights();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  server.once('GET', '/breakdown', { body: { coffee: { posted: 5, pending: 0 } } });
  await fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  expect(await screen.findByText('LAST PAY CYCLE')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('insights-cycle-current'));
  expect(await screen.findByText('THIS PAY CYCLE')).toBeTruthy();
  expect(refreshAiInsights).toHaveBeenCalledTimes(1);
});

// --- WHIT-68: historical look-back selector ----------------------------------

it('the cycle selector reads the prior cycle, relabels the hero, and hides the AI coach', async () => {
  await renderInsights();

  // current cycle: "THIS PAY CYCLE" eyebrow + the AI coach card present
  expect(await screen.findByText('THIS PAY CYCLE')).toBeTruthy();
  expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Worth a look')).toBeTruthy();

  server.once('GET', '/breakdown', { body: { coffee: { posted: 5, pending: 0 } } });
  await fireEvent.press(screen.getByTestId('insights-cycle-prev'));

  expect(await screen.findByText('LAST PAY CYCLE')).toBeTruthy();
  // The prior-cycle read fired with cycle=1; the `days` param is inconsequential (the server
  // derives the window) and varies with whether the pay cycle has resolved, so don't pin it.
  expect(server.sent('GET', '/breakdown?cycle=1').length).toBeGreaterThan(0);
  expect(screen.queryByText('Worth a look')).toBeNull();   // AI coach hidden on a past cycle

  // back to "This cycle" — served from cache (no new fetch), label + coach return
  const callsBefore = server.sentUnder('GET', '/breakdown').length;
  await fireEvent.press(screen.getByTestId('insights-cycle-current'));
  expect(await screen.findByText('THIS PAY CYCLE')).toBeTruthy();
  expect(screen.getByText('Worth a look')).toBeTruthy();
  expect(server.sentUnder('GET', '/breakdown')).toHaveLength(callsBefore); // cycle 0 already cached
});

// --- WHIT-189 GAPS (qa's adversarial half, folded in by WHIT-467) -------------

describe('partial failure: categories down while breakdown succeeds', () => {
  // WHIT-194: with no taxonomy (categories failed on first load), categoryBreakdown drops
  // every REAL-category row but the Uncategorized bucket survives (needs no taxonomy). That
  // surviving row used to make rows.length > 0 and SUPPRESS the inline error, showing a hero
  // total that silently omitted the real categories. The fix surfaces the error via the
  // composite's `categoriesError` (categoriesQuery errored with no cached data), and gates
  // the row list on !showError so the partial uncat row can't leak under the error card.
  it('breakdown has real + uncategorized spend, categories failed on first load → the inline error IS shown (no partial hero)', async () => {
    server.fail('/categories', 500);
    server.seed('/breakdown', { coffee: { posted: 40, pending: 0 }, [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } });
    await renderInsights(makeClient());
    expect(await screen.findByTestId('insights-error')).toBeTruthy();     // error surfaces now
    expect(screen.getByText("Couldn't load")).toBeTruthy();               // ...and the hero says so
    expect(screen.queryByText('Cafes & Coffee')).toBeNull();             // real row dropped (no taxonomy)
    expect(screen.queryByText('Uncategorized')).toBeNull();              // surviving uncat row suppressed under the error
    expect(screen.queryByText('$25')).toBeNull();                        // no partial hero/row total
    expect(screen.queryByText('$65')).toBeNull();
  });
});

describe('focus refetch does not storm', () => {
  it('fresh data + focus effect (staleTime 60s) → each fetcher called exactly once', async () => {
    await renderInsights();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(server.sent('GET', '/paycycle')).toHaveLength(1); // the hero's day of the cycle reads it (ABU-62)
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(1);
    expect(server.sent('GET', '/categories')).toHaveLength(1);
  });
});

describe('auth transition mid-session on Insights', () => {
  it('authed→locked keeps cached rows, shows no error, and fires no doomed refetch', async () => {
    await renderInsights();
    expect(await screen.findByText('Cafes & Coffee')).toBeTruthy();
    const before = server.sentUnder('GET', '/breakdown').length;

    await act(async () => {
      setAuthStatus('locked');
    });
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy(); // cache survives
    expect(screen.queryByTestId('insights-error')).toBeNull();
    expect(server.sentUnder('GET', '/breakdown')).toHaveLength(before); // no new fetch while locked
  });
});
