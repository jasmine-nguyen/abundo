// WHIT-189 GAPS (adversarial half, authored by qa) — pins the three states of the Insights hero
// apart and proves the breakdown and AI features are visually INDEPENDENT — one failing must not
// hide/alter the other. Complements InsightsScreen.screen.test.tsx (happy path).
// WHIT-687: drawn over the fake server with the shared Insights kit — loading / error states come
// from held and failed replies, so the real screen data code decides what the hero shows.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen } from '@testing-library/react-native';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, drawInsights, resetAi, setAi } from './support/insightsScreen';
import { queryClient } from '../queryClient';
import { breakdownKey } from '../queries';
import { UNCATEGORIZED_KEY } from '../model';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

const CATS = [{ id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle' }];
const UNCAT_ONLY = breakdownWire({ spend: { [UNCATEGORIZED_KEY]: { posted: 25, pending: 0 } } });

beforeEach(() => {
  resetAuth();
  resetAi();
  seedInsights(server, { breakdown: breakdownWire({}), categories: CATS });
});

// --- the three hero states, pinned apart (loaded-empty must NOT be suppressed) ---

describe('hero state: legit zero-spend cycle', () => {
  it('a loaded, empty breakdown (no error, not loading) shows a real $0 / 0 categories — NOT suppressed to "—"', async () => {
    await renderInsights();
    // The whole point of the WHIT-189 hero fix: only a load/error hides the number.
    // A genuine zero-spend cycle is real data and must read $0, not the "—" placeholder.
    expect(screen.getByText('$0')).toBeTruthy();
    expect(screen.getByText(/across 0 categories/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.queryByText("Couldn't load")).toBeNull();
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
  });
});

describe('hero state: loading vs error placeholders (no false $0)', () => {
  it('loading (nothing cached) → hero reads "—" / "Loading…", never $0', async () => {
    const held = server.hold('/breakdown');
    drawInsights();
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();

    held.release();
    expect(await screen.findByText('$0')).toBeTruthy();
  });

  it('error (nothing cached) → hero reads "—" / "Couldn\'t load", never $0', async () => {
    server.fail('/breakdown', 500);
    await renderInsights();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    expect(screen.queryByText('$0')).toBeNull();
  });
});

// --- WHIT-194: a first-load categories failure suppresses the partial hero ---

describe('categoriesError: first-load taxonomy failure surfaces the error, not a partial hero', () => {
  it('breakdown has an Uncategorized row but categories never loaded → error shown, no partial row/total leaks', async () => {
    // Categories failed with no cached taxonomy. Even though a taxonomy-free Uncategorized row
    // survives in the breakdown, the screen must show the error and suppress that row — never a
    // hero total that omits real spend.
    seedInsights(server, { breakdown: UNCAT_ONLY, categories: CATS });
    server.fail('/categories', 500);
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();   // error surfaces
    expect(screen.getByText("Couldn't load")).toBeTruthy();      // hero says so
    expect(screen.queryByText('Uncategorized')).toBeNull();      // partial row suppressed by !showError gate
    expect(screen.queryByText('$25')).toBeNull();                // no partial total
  });
});

// --- WHIT-194: a failed refetch with rows still cached must NOT hide the rows (cache-first) ---

describe('cache-first: an errored refetch over good cached rows keeps the rows, no error card', () => {
  it('a failed breakdown refetch over a cached row → row + total show, NO "Couldn\'t load"', async () => {
    // The paired render-level lock for insightsBreakdownCacheFirst (which proves the hook
    // surfaces isError while v5 retains breakdown data). showError = (isError && rows.length === 0)
    // || categoriesError must be FALSE, so the row survives. Fail-on-revert: dropping the
    // `&& rows.length === 0` guard (showError = isError || categoriesError) blanks the row and
    // shows the error here.
    seedInsights(server, { breakdown: UNCAT_ONLY, categories: CATS });
    await renderInsights();
    expect(screen.getByText('Uncategorized')).toBeTruthy();

    server.fail('/breakdown', 500);
    await refreshInAct(() => queryClient.refetchQueries({ queryKey: breakdownKey }).catch(() => {}));
    expect(queryClient.getQueryState([...breakdownKey, 0])?.status).toBe('error'); // the refetch really failed

    expect(screen.queryByTestId('insights-error')).toBeNull();     // no error card over cached rows
    expect(screen.queryByText("Couldn't load")).toBeNull();        // hero keeps its number, not "—"
    expect(screen.getByText('Uncategorized')).toBeTruthy();        // the cached row survives
    expect(screen.getAllByText('$25').length).toBeGreaterThanOrEqual(1); // hero + row total intact
  });
});

// --- breakdown and AI are independent features on one screen -----------------

describe('breakdown error does NOT break the AI card', () => {
  it('breakdown in error (rows gone, hero "—") while AI advice exists → AI card still fully renders', async () => {
    server.fail('/breakdown', 500);
    setAi({
      insights: { summary: 'You are pacing well.', suggestions: ['Trim $20 from Coffee'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    });
    await renderInsights();
    // breakdown side is in its error state...
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load")).toBeTruthy();
    // ...but the AI coach card is untouched.
    expect(screen.getByText('You are pacing well.')).toBeTruthy();
    expect(screen.getByText('Trim $20 from Coffee')).toBeTruthy();
    expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
  });
});

describe('AI error does NOT hide the breakdown rows', () => {
  it('AI generation failed while breakdown has spend → rows + real hero total still show', async () => {
    seedInsights(server, { breakdown: breakdownWire({ spend: { coffee: { posted: 30, pending: 0 } } }), categories: CATS });
    setAi({ insights: null, isError: true });
    await renderInsights();
    // AI side shows its own failure...
    expect(screen.getByText(/Couldn’t generate insights/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
    // ...and the breakdown rows + hero are unaffected (real $30, not "—").
    expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
    // $30 appears twice (hero total + row amount); the load/error placeholder does not.
    expect(screen.getAllByText('$30').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('—')).toBeNull();
    expect(screen.queryByTestId('insights-error')).toBeNull();
  });
});
