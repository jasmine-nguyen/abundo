// Screen test: the Insights tab. WHIT-687: drawn over the fake server with the shared Insights kit,
// so the real screen data code (useInsightsScreenData / useGoalScreenData) builds the breakdown,
// earned, income sources and categories from server replies. Loading and error states come from
// held and failed replies. The AI-insights feature still reads the context store (`useAppContext`),
// which the kit stands in for with a slice a test can set.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { routerSpies, fireFocus, resetRouter } from './support/routerMock';
import { AccessibilityInfo } from 'react-native';
import { screen, fireEvent, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { UNCATEGORIZED_KEY } from '../model';
import { C } from '../theme';
import { CATEGORY_COLORS } from '../chartColors';
import { queryClient } from '../queryClient';
import { breakdownKey } from '../queryKeys';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient, settle, loaded } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import {
  breakdownWire, seedInsights, renderInsights, drawInsights, redrawInsights, resetAi, setAi,
  refreshAiInsights, generateAiInsights,
} from './support/insightsScreen';
import { GROCERIES_RECORD } from './support/categories';
import { styleOf } from './support/layout';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../context', () => require('./support/insightsScreen').contextMockModule());

// The focus callback runs once on mount; fireFocus() fires a later focus by hand. routerSpies.push
// is the spy the category-row drills call.
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

type Spend = Record<string, { posted: number; pending: number }>;
const posted = (n: number) => ({ posted: n, pending: 0 });

const CATS = [
  { id: 'coffee', name: 'Cafes & Coffee', icon: 'coffee', bucket: 'Lifestyle' },
  { ...GROCERIES_RECORD },
];

const READY_LOAN_FACTS = { original: 600000, homeValue: 770000, lvr: 0.8, ratePct: 5.74, baseRepay: 3667, extra: 500 };
const TWO_ROWS = { coffee: { posted: 20, pending: 5 }, groceries: posted(80) };

function seedBreakdown(wire: Parameters<typeof breakdownWire>[0], categories: unknown[] = CATS) {
  seedInsights(server, { breakdown: breakdownWire(wire), categories });
}

const breakdownReads = () => server.sentUnder('GET', '/breakdown').length;

async function showLastCycle() {
  fireEvent.press(screen.getByTestId('insights-cycle-prev'));
  await loaded([...breakdownKey, 1]);
  await settle();
}

beforeEach(() => {
  resetRouter();
  resetAuth();
  resetAi();
  seedBreakdown({});
});

// --- breakdown (WHIT-23 / WHIT-189) ------------------------------------------

it('renders a row per spent category with the pending portion visible', async () => {
  seedBreakdown({ spend: TWO_ROWS });
  await renderInsights();
  expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
  expect(screen.getByText('Groceries')).toBeTruthy();
  expect(screen.getByText(/\$5 pending/)).toBeTruthy();
});

it('shows the Uncategorized bucket as a row', async () => {
  seedBreakdown({ spend: { coffee: posted(40), [UNCATEGORIZED_KEY]: posted(25) } });
  await renderInsights();
  expect(screen.getByText('Uncategorized')).toBeTruthy();
});

it('shows an empty state when there is no spend', async () => {
  await renderInsights();
  expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
});

describe('the spending donut', () => {
  it('draws once there is spend', async () => {
    seedBreakdown({ spend: TWO_ROWS });
    await renderInsights();
    expect(screen.getByTestId('insights-donut')).toBeTruthy();
  });

  it('is not drawn with no spend', async () => {
    await renderInsights();
    expect(screen.queryByTestId('insights-donut')).toBeNull();
  });

  it('is not drawn over an error, even with a spend row', async () => {
    // The Uncategorized row survives a categories failure, so only the error gate hides the donut.
    seedBreakdown({ spend: { [UNCATEGORIZED_KEY]: posted(25) } });
    server.fail('/categories', 500);
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.queryByTestId('insights-donut')).toBeNull();
  });
});

it('draws the earned-vs-spent chart when there is spend, on BOTH cycle tabs', async () => {
  seedBreakdown({ spend: TWO_ROWS, earned: 3000 });
  await renderInsights();
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
  // Unlike the AI coach card (current-cycle only), it stays on "Last cycle" too.
  await showLastCycle();
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
});

it('shows the earned-vs-spent chart on an income-only cycle (income, no spend rows)', async () => {
  seedBreakdown({ earned: 3000 }); // earned but nothing spent
  await renderInsights();
  expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
});

describe('the earned-vs-spent chart is never drawn over an empty/loading/error state', () => {
  it('no income and no spend → no chart', async () => {
    seedBreakdown({ earned: 0 });
    await renderInsights();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
  });

  it('first load → no chart, even once the income has arrived', async () => {
    // The breakdown (with earned) lands; the categories are still loading, so the spinner shows.
    seedBreakdown({ earned: 3000 });
    const held = server.hold('/categories');
    drawInsights();
    expect(await screen.findByTestId('insights-loading')).toBeTruthy();
    await loaded([...breakdownKey, 0]);
    await refreshInAct(() => Promise.resolve());
    expect(screen.getByTestId('insights-loading')).toBeTruthy();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
    await refreshInAct(() => held.release());
    await settle();
    expect(await screen.findByTestId('insights-earned-spent')).toBeTruthy(); // positive control
  });

  it('an error with the income already in → no chart', async () => {
    // Categories never loaded → showError, while earned is 3000.
    seedBreakdown({ earned: 3000 });
    server.fail('/categories', 500);
    await renderInsights();
    expect(screen.getByTestId('insights-error')).toBeTruthy();
    expect(screen.queryByTestId('insights-earned-spent')).toBeNull();
  });
});

it('refreshes breakdown (query) AND AI on focus', async () => {
  await renderInsights();
  expect(refreshAiInsights).toHaveBeenCalled();
  refreshAiInsights.mockClear();
  // The first load is still fresh, and a focus refresh only re-reads stale data. Mark it stale so
  // the next focus must send a NEW breakdown read (the first-load read alone can't pass this).
  await refreshInAct(() => queryClient.invalidateQueries({ refetchType: 'none' }));
  const before = breakdownReads();

  await refreshInAct(() => fireFocus());
  await settle();

  expect(breakdownReads()).toBeGreaterThan(before);
  expect(refreshAiInsights).toHaveBeenCalled();
});

it('renders the hero total and pluralised category count', async () => {
  seedBreakdown({ spend: TWO_ROWS }); // 25 + 80
  await renderInsights();
  // The donut centre also reads the total now, so target the hero by testID to disambiguate.
  expect(screen.getByTestId('insights-hero-total').props.children).toBe('$105');
  expect(screen.getByText(/across 2 categories/)).toBeTruthy();
});

it('uses the singular "category" for exactly one spent row', async () => {
  seedBreakdown({ spend: { coffee: posted(12) } });
  await renderInsights();
  expect(screen.getByText(/across 1 category$/)).toBeTruthy();
});

it('shows a spinner (not the empty state, not a false $0) while a first fetch is in flight', async () => {
  const held = server.hold('/breakdown');
  drawInsights();
  expect(await screen.findByTestId('insights-loading')).toBeTruthy();
  expect(screen.queryByText('No spending yet this pay cycle.')).toBeNull();
  expect(screen.queryByText('$0')).toBeNull(); // hero must not show a confident $0
  held.release();
  await settle();
});

it('shows an inline error + Retry (not a false $0) on a sustained breakdown failure', async () => {
  server.fail('/breakdown', 500);
  await renderInsights();
  expect(screen.getByTestId('insights-error')).toBeTruthy();
  const before = breakdownReads();
  await refreshInAct(() => fireEvent.press(screen.getByTestId('insights-retry')));
  await settle();
  expect(breakdownReads()).toBeGreaterThan(before); // Retry re-reads the breakdown
  expect(screen.queryByText('$0')).toBeNull();
});

// --- AI insights (WHIT-104) — unchanged behaviour, still on the context store ---

it('shows the idle prompt + the analyse button before any AI insight exists', async () => {
  await renderInsights();
  expect(screen.getByText('Worth a look')).toBeTruthy();
  expect(screen.getByText('Analyse my spending')).toBeTruthy();
  expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
});

it('tapping "Analyse my spending" calls generateAiInsights', async () => {
  await renderInsights();
  fireEvent.press(screen.getByText('Analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('keeps the note spend-only (no loan figures) when the loan goal is not ready', async () => {
  await renderInsights();
  expect(screen.getByText(/Sends your category spend totals to Anthropic/)).toBeTruthy();
  expect(screen.queryByText(/home-loan figures/)).toBeNull();
});

describe('with the loan goal ready', () => {
  beforeEach(() => {
    server.seed('/loanfacts', READY_LOAN_FACTS);
    server.seed('/homeloan', { balance: 528000, as_of: null, currency: 'AUD' });
  });

  it('names home-loan figures in the note + sends a goal once the loan is ready (WHIT-134)', async () => {
    await renderInsights();
    expect(screen.getByText(/home-loan figures \(balance, rate, repayments\)/)).toBeTruthy();
    fireEvent.press(screen.getByText('Analyse my spending'));
    expect(generateAiInsights).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead', mortgage_free_date: expect.any(String) }));
  });

  it('the COMPACT refresh also forwards the goal with loan figures named', async () => {
    setAi({ aiInsights: { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false } });
    await renderInsights();
    expect(screen.getByText(/Re-analysing sends your category spend totals and home-loan figures/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
    expect(generateAiInsights).toHaveBeenCalledWith(expect.objectContaining({ payoff_mode: 'ahead', mortgage_free_date: expect.any(String) }));
  });
});

it('renders the AI summary + each suggestion once generated', async () => {
  setAi({
    aiInsights: { summary: 'You are pacing well this cycle.', suggestions: ['Trim $20 from Coffee', 'Watch Groceries'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
  });
  await renderInsights();
  expect(screen.getByText('You are pacing well this cycle.')).toBeTruthy();
  expect(screen.getByText('Trim $20 from Coffee')).toBeTruthy();
  expect(screen.getByText('Watch Groceries')).toBeTruthy();
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
  expect(screen.queryByText('Analyse my spending')).toBeNull();
  expect(screen.getByText(/Re-analysing sends your category spend totals to Anthropic/)).toBeTruthy();
});

it('tapping the compact refresh re-runs generation', async () => {
  setAi({ aiInsights: { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false } });
  await renderInsights();
  fireEvent.press(screen.getByLabelText('Re-analyse my spending'));
  expect(generateAiInsights).toHaveBeenCalled();
});

it('shows a "generated ago" stamp from the timestamp', async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  setAi({ aiInsights: { summary: 'ok', suggestions: [], generated_at: twoDaysAgo, cycle_start: '2026-06-25', cached: true } });
  await renderInsights();
  expect(screen.getByText('2d ago')).toBeTruthy();
});

it('keeps the insight visible + swaps the refresh for a spinner while re-running', async () => {
  setAi({
    aiInsights: { summary: 'still here', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsLoading: true,
  });
  await renderInsights();
  expect(screen.getByText('still here')).toBeTruthy();
  expect(screen.getByTestId('ai-refresh-busy')).toBeTruthy();
  expect(screen.queryByLabelText('Re-analyse my spending')).toBeNull();
});

it('surfaces a failed re-analyse without dropping the existing advice', async () => {
  setAi({
    aiInsights: { summary: 'keep me', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false },
    aiInsightsError: true,
  });
  await renderInsights();
  expect(screen.getByText('keep me')).toBeTruthy();
  expect(screen.getByText(/Couldn’t refresh/)).toBeTruthy();
  expect(screen.getByLabelText('Re-analyse my spending')).toBeTruthy();
});

it('shows a retryable error when generation failed', async () => {
  setAi({ aiInsights: null, aiInsightsError: true });
  await renderInsights();
  expect(screen.getByText(/Couldn’t generate insights/)).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
});

it('refreshes any cached AI insight when the tab gains focus', async () => {
  await renderInsights();
  expect(refreshAiInsights).toHaveBeenCalled();
});

// --- WHIT-142: screen-reader a11y for the AI re-analyse busy/result --------------
const AI = { summary: 'ok', suggestions: ['a'], generated_at: 't', cycle_start: '2026-06-25', cached: false };

describe('AI re-analyse a11y (WHIT-142)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('gives the re-analyse busy spinner an accessible name (labelled control is unmounted)', async () => {
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    await renderInsights();
    expect(screen.getByLabelText('Re-analysing your spending')).toBeTruthy();
    expect(screen.queryByLabelText('Re-analyse my spending')).toBeNull(); // the button is gone while busy
  });

  it('gives the first-run generate busy spinner an accessible name', async () => {
    setAi({ aiInsights: null, aiInsightsLoading: true });
    await renderInsights();
    expect(screen.getByLabelText('Analysing your spending')).toBeTruthy();
    expect(screen.getByTestId('ai-generate-busy')).toBeTruthy();
  });

  it('announces success on the loading → done edge', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    const view = await renderInsights();
    expect(announce).not.toHaveBeenCalled(); // still analysing → nothing yet

    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    redrawInsights(view);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('Spending analysis ready.');
  });

  // WHIT-68: if the user switches to a PAST cycle mid-analysis, the coach card unmounts, so
  // the loading→done announce must NOT fire — otherwise a screen reader claims content is
  // "ready" for a card that's no longer on screen.
  it('does NOT announce when analysis finishes while viewing a past cycle (coach hidden)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    const view = await renderInsights();

    await showLastCycle(); // move to Last cycle → coach hidden
    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    redrawInsights(view);

    expect(announce).not.toHaveBeenCalled(); // withheld while the coach is off-screen
  });

  it('announces failure on the loading → done edge when the run errored', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    const view = await renderInsights();

    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: true });
    redrawInsights(view);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("Couldn't analyse your spending. Please try again.");
  });

  // The real regression this card guards: the announce must NOT fire except on a genuine
  // analyse/re-analyse completion — not on mount, not on a mid-load mount, not on tab focus.
  it('does NOT announce on a plain mount (never analysing)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: false });
    await renderInsights(); // useFocusEffect fires refreshAiInsights on mount — must not announce
    expect(announce).not.toHaveBeenCalled();
  });

  it('does NOT announce when it mounts already loading (no transition witnessed)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    await renderInsights();
    expect(announce).not.toHaveBeenCalled();
  });

  it('does NOT announce on a focus re-render while loading stays constant', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: false });
    const view = await renderInsights();
    redrawInsights(view); // a re-render with no loading transition (e.g. focus refetch)
    expect(announce).not.toHaveBeenCalled();
  });
});

// Adversarial gap tests (qa): re-arming across runs, the first-run (no-insight) completion
// path, and a stronger at-rest negative that a "fire whenever !loading" bug would fail.
describe('AI re-analyse a11y — gap tests (WHIT-142)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  // Re-arm: two full analyse cycles must announce twice. Guards the ref reset — drop it and
  // the ref never re-arms, so the 2nd completion never announces.
  it('announces once per completion across a true→false→true→false sequence', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    const view = await renderInsights();

    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    redrawInsights(view); // 1st completion → announce #1
    expect(announce).toHaveBeenCalledTimes(1);

    setAi({ aiInsights: AI, aiInsightsLoading: true });
    redrawInsights(view); // re-analyse starts again → no announce, re-arm
    expect(announce).toHaveBeenCalledTimes(1);

    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    redrawInsights(view); // 2nd completion → announce #2
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith('Spending analysis ready.');
  });

  // First-run path, NOT gated on hasAi: a first-run generate that FAILS leaves aiInsights null
  // (hasAi stays false), so a hasAi-gated announce would wrongly stay silent. It must still
  // speak the failure. Pins both the first-run failure announce and the no-hasAi-gate contract
  // (a first-run SUCCESS can't pin it — success populates aiInsights, making hasAi true anyway).
  it('announces failure when a FIRST-RUN generate fails (aiInsights stays null → not gated on hasAi)', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: null, aiInsightsLoading: true });
    const view = await renderInsights();
    expect(screen.getByTestId('ai-generate-busy')).toBeTruthy(); // first-run busy element
    expect(announce).not.toHaveBeenCalled();

    setAi({ aiInsights: null, aiInsightsLoading: false, aiInsightsError: true });
    redrawInsights(view);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith("Couldn't analyse your spending. Please try again.");
  });

  // At-rest negative: announce once on a real edge, then a further at-rest re-render (e.g. a
  // focus refetch) must NOT re-announce. Guards post-completion quiescence — it catches a
  // "fire on every render while !loading" degradation (the kind that also drops dep-skipping);
  // an identical-deps re-render is otherwise skipped by React, which is itself the correct outcome.
  it('does NOT re-announce on an at-rest re-render after a completion', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    setAi({ aiInsights: AI, aiInsightsLoading: true });
    const view = await renderInsights();

    setAi({ aiInsights: AI, aiInsightsLoading: false, aiInsightsError: false });
    redrawInsights(view); // completion → announce once
    expect(announce).toHaveBeenCalledTimes(1);

    redrawInsights(view); // same at-rest state → must stay at 1
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

// WHIT-312 (qa gaps) — the earned-vs-spent chart's interaction with the screen's other states.
describe('earned-vs-spent chart — screen gaps (WHIT-312)', () => {
  // [A9] income-only cycle: the chart shows AND the "No spending yet" empty text still shows
  // (rows.length===0). Pins the CURRENT double-message behaviour so a future change to either
  // gate is a conscious decision, not a silent regression. (Flagged in the critique.)
  it('an income-only cycle shows BOTH the chart and the no-spending empty text', async () => {
    seedBreakdown({ earned: 3000 });
    await renderInsights();
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();
    expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
    // Nothing spent means the whole income is surplus, so the pairing reads coherently.
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$3,000 surplus');
  });

  // [A10] the chart's spent bar reads the SAME total as the hero — both come off categoryBreakdown,
  // so they can't diverge. 20 + 5 + 80 = 105. Guards against the chart being fed a different spend.
  it('feeds the chart the same spend total as the hero', async () => {
    seedBreakdown({ spend: TWO_ROWS, earned: 3000 });
    await renderInsights();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$105');
    // The surplus is earned − spent = 3000 − 105: it can only read $2,895 if the chart was
    // fed the SAME $105 spend total the hero shows. A different spend would change this string.
    expect(screen.getByTestId('earned-vs-spent-amount').props.children).toBe('+$2,895 surplus');
  });
});

// WHIT-373 — the Earned/Spent card is a pure summary now: no per-bar drill chevron, no press
// targets. The Spending/Earning toggle below is the one way to drill in (see insightsSideToggle).
describe('Earned/Spent card is summary-only (WHIT-373)', () => {
  it('renders no drill press targets on either bar', async () => {
    seedBreakdown({ spend: { coffee: posted(40) }, earned: 3000, income: { salary: posted(3000) } });
    await renderInsights();
    expect(screen.getByTestId('insights-earned-spent')).toBeTruthy();  // card still shows
    expect(screen.queryByTestId('earned-bar-press')).toBeNull();       // no Earned drill
    expect(screen.queryByTestId('spent-bar-press')).toBeNull();        // no Spent drill
    // FAIL-ON-REVERT: restoring the onSpentPress wiring makes spent-bar-press render again.
  });
});

// Car with two subs, used by the refund-line and remainder suites below.
const CAR_CATS = [
  { id: 'car', name: 'Car', icon: 'car', bucket: 'Living', parent: null },
  { id: 'petrol', name: 'Petrol', icon: 'car', bucket: 'Living', parent: 'car' },
  { id: 'tolls', name: 'Tolls', icon: 'car', bucket: 'Living', parent: 'car' },
];

// petrol 60, tolls net -30 (floored to 0), car node netted to 30 + a tolls refund line.
function seedCarRefund() {
  seedBreakdown({
    spend: { petrol: posted(60), tolls: posted(0) },
    rollup: { nodes: { car: posted(30) }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
  }, CAR_CATS);
}

describe('Insights refund line (WHIT-349)', () => {
  beforeEach(seedCarRefund);

  it('shows the netted parent, then a tappable refund line when expanded', async () => {
    await renderInsights();
    // The Car parent renders (its netted $30 total is locked in the logic test).
    expect(screen.getByText('Car')).toBeTruthy();
    // Collapsed: the refund line isn't shown yet.
    expect(screen.queryByText(/refund/)).toBeNull();

    // Expand Car -> the refund line appears, reconciling petrol 60 - 30 = 30.
    fireEvent.press(screen.getByText('Car'));
    expect(screen.getByText('Petrol')).toBeTruthy();
    expect(screen.getByText('Tolls')).toBeTruthy();
    expect(screen.getByText(/refund/)).toBeTruthy();

    // A tap on the refund line drills into the refunded sub's transactions.
    fireEvent.press(screen.getByText('Tolls'));
    expect(routerSpies.push).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));
  });
});

describe('Insights refund line gaps (WHIT-349)', () => {
  beforeEach(seedCarRefund);

  it('the hero shows the NETTED parent total (30), never the floored-leaf sum (60)', async () => {
    await renderInsights();
    // The hero total reads the netted cycle spend: car node 30, NOT petrol's floored 60.
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
  });

  it('the refund is not counted as a category: "spent across 1 category"', async () => {
    await renderInsights();
    // One top-level category (Car). The refund line is NEVER a top-level row / donut wedge, so
    // the count stays 1 even though a Tolls refund line exists under Car.
    expect(screen.getByText('spent across 1 category')).toBeTruthy();
  });

  it('expanding does not change the hero total (refund is display-only)', async () => {
    await renderInsights();
    fireEvent.press(screen.getByText('Car'));
    // The refund line now renders, but the hero total is unchanged — it is excluded from the total.
    expect(screen.getByText(/refund/)).toBeTruthy();
    expect(screen.getByTestId('insights-hero-total').props.children).toBe('$30');
  });
});

describe('Insights remainder/Other plug (WHIT-357/375)', () => {
  // petrol 100, tolls net -30 (floored to 0 -> refund line), car node 130. The visible children sum to
  // 100 + (-30) = 70, under-summing the node (130) -> WHIT-357 plugs a +60 "Other" line under car.
  // $60 appears nowhere else on screen (100 / 130 / 30 are the other amounts), so it uniquely marks the plug.
  beforeEach(() => {
    seedBreakdown({
      spend: { petrol: posted(100), tolls: posted(0) },
      rollup: { nodes: { car: posted(130) }, refunds: { car: [{ id: 'tolls', amount: -30 }] } },
    }, CAR_CATS);
  });

  // Climb to the enclosing row card (styles.row is the only node with borderRadius 20).
  function rowCard(node: ReactTestInstance): ReactTestInstance {
    let n: ReactTestInstance | null = node;
    while (n) {
      if (styleOf(n).borderRadius === 20) return n;
      n = n.parent;
    }
    throw new Error('no enclosing row card');
  }
  // A category-bar track (styles.track: height 8) — present on a real spend row, absent on a plug/refund.
  const tracksIn = (card: ReactTestInstance) => card.findAll((n) => styleOf(n).height === 8);
  // The bold amount Text (styles.rowAmount: fontWeight '700') inside a card.
  const amountColor = (card: ReactTestInstance) =>
    styleOf(card.findAll((n) => styleOf(n).fontWeight === '700')[0]).color;

  // The row NAME Text (styles.rowName: fontWeight '600') inside a card — its colour moved from a
  // hardcoded C.textDim to breakdownLineStyle's nameColor in WHIT-375, so lock it here.
  const nameColor = (card: ReactTestInstance) =>
    styleOf(card.findAll((n) => styleOf(n).fontWeight === '600')[0]).color;

  it('hides the "Other" plug until the parent is expanded, then shows it muted, un-barred, and un-tappable', async () => {
    await renderInsights();
    // Collapsed: the plug is not shown.
    expect(screen.queryByText('Pending/refund adjustment')).toBeNull();

    // Expand Car -> children + the refund line + the adjustment plug appear.
    fireEvent.press(screen.getByText('Car'));
    expect(screen.getByText('Petrol')).toBeTruthy();
    const other = screen.getByText('Pending/refund adjustment');
    expect(other).toBeTruthy();

    const card = rowCard(other);
    // (a) neutral-coloured amount — textDim, NOT the refund green (C.good).
    expect(amountColor(card)).toBe(C.textDim);
    expect(amountColor(card)).not.toBe(C.good);
    // (b) NO bar/track under the plug row.
    expect(tracksIn(card)).toHaveLength(0);
    // (c) NOT tappable — no button in the row, and pressing it drills nowhere.
    expect(within(card).queryByRole('button')).toBeNull();
    fireEvent.press(other);
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  it('the refund line under the SAME parent stays green + tappable — proving the plug checks are meaningful', async () => {
    await renderInsights();
    fireEvent.press(screen.getByText('Car'));

    // Positive control 1: the refund line ('Tolls') is green and IS a drill target.
    const refundCard = rowCard(screen.getByText('Tolls'));
    expect(amountColor(refundCard)).toBe(C.good);
    expect(within(refundCard).queryByRole('button')).toBeTruthy();
    fireEvent.press(screen.getByText('Tolls'));
    expect(routerSpies.push).toHaveBeenCalledWith(expect.stringContaining('/category/tolls'));

    // Positive control 2: a real spend row (Petrol) DOES carry a bar/track — so the plug's
    // "no track" assertion above is a real difference, not a query that never finds tracks.
    expect(tracksIn(rowCard(screen.getByText('Petrol')))).not.toHaveLength(0);
  });

  // WHIT-375 — [A1] gap symmetric to the breakdown refund test. insightsRemainderLine only locked
  // the refund COLOUR (green) + tappability, never that its AMOUNT is UNSIGNED. The refund's spent is
  // -30; the shared breakdownLineStyle must drop the sign so the line reads "$30", never "-$30" (the
  // historical drift the card guards). Fail-on-revert: sign the helper's amount and this flips to "-$30".
  it('renders the refund line amount UNSIGNED ("$30", never "-$30")', async () => {
    await renderInsights();
    fireEvent.press(screen.getByText('Car'));

    const refundCard = rowCard(screen.getByText('Tolls'));
    expect(within(refundCard).getByText('$30')).toBeTruthy();   // unsigned credit
    expect(within(refundCard).queryByText('-$30')).toBeNull();  // never the signed drift
  });

  // WHIT-375 — [A2] the refund/remainder NAME colour moved from a hardcoded C.textDim to the helper's
  // nameColor. Prove it's unchanged on BOTH kinds of line: dimmed (C.textDim), NOT the bright category
  // ink (C.textBright). Fail-on-revert: if the helper returned textBright for a refund/remainder name,
  // these flip.
  it('keeps the refund AND remainder NAME dimmed (C.textDim, not the bright ink)', async () => {
    await renderInsights();
    fireEvent.press(screen.getByText('Car'));

    const refundName = nameColor(rowCard(screen.getByText('Tolls')));
    expect(refundName).toBe(C.textDim);
    expect(refundName).not.toBe(C.textBright);

    const plugName = nameColor(rowCard(screen.getByText('Pending/refund adjustment')));
    expect(plugName).toBe(C.textDim);
    expect(plugName).not.toBe(C.textBright);

    // Control: a real spend row (Petrol) keeps the BRIGHT name — so "dimmed" is a real difference,
    // not a colour every row happens to share.
    expect(nameColor(rowCard(screen.getByText('Petrol')))).toBe(C.textBright);
  });

  it('a NEGATIVE "Other" plug renders its minus sign (WHIT-357 R1) so the rows visibly still add up', async () => {
    // Trigger-2 shape: car own spend 100, but its node is 60 (a dropped net-negative sub ate 40).
    // The plug is -40. `fmt` strips the sign, so without the R1 fix this renders "$40" and the rows
    // read as 100 + 40 = 140 under a $60 parent. Assert the minus is shown.
    seedBreakdown({
      spend: {
        car: posted(100),      // car's OWN directly-tagged spend -> "Directly in Car" 100
        petrol: posted(0),     // a sub that floored away (keeps car a parent)
      },
      rollup: { nodes: { car: posted(60) } },   // node 60 < own 100 -> -40 plug
    }, CAR_CATS);
    await renderInsights();
    fireEvent.press(screen.getByText('Car'));

    const other = screen.getByText('Pending/refund adjustment');
    const card = rowCard(other);
    // The amount shows the sign: "-$40", not a bare "$40".
    expect(within(card).getByText('-$40')).toBeTruthy();
    expect(within(card).queryByText('$40')).toBeNull();   // no unsigned amount that would mislead
  });
});

// Spending + income categories for the toggle and share-bar suites below.
const SIDE_CATS = [
  ...CATS,
  { id: 'salary', name: 'Salary', icon: 'briefcase', bucket: 'Income' },
  { id: 'dividends', name: 'Dividends', icon: 'trend', bucket: 'Income' },
];

function seedSides(wire: { spend?: Spend; earned?: number; income?: Spend }) {
  seedBreakdown(wire, SIDE_CATS);
}

describe('Insights spending/earning toggle (WHIT-373)', () => {
  // Spend + income both present, so the toggle has content on both sides.
  const BOTH = {
    spend: { coffee: posted(20), groceries: posted(80) },
    earned: 3500,
    income: { salary: posted(3000), dividends: posted(500) },
  };

  describe('Spending / Earning toggle (WHIT-373)', () => {
    it('defaults to Spending: category rows + spend caption show, income does not', async () => {
      seedSides(BOTH);
      await renderInsights();
      expect(screen.getByTestId('insights-side-spending')).toBeTruthy();
      expect(screen.getByTestId('insights-bars-caption')).toBeTruthy();           // spend caption
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByText('Salary')).toBeNull();                            // income hidden
      expect(screen.queryByTestId('insights-income-caption')).toBeNull();
    });

    it('switching to Earning shows income sources and hides the category rows', async () => {
      seedSides(BOTH);
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Salary')).toBeTruthy();
      expect(screen.getByText('$3,000')).toBeTruthy();
      expect(screen.getByText('Dividends')).toBeTruthy();
      expect(screen.getByTestId('insights-income-caption')).toBeTruthy();         // income caption
      expect(screen.queryByText('Cafes & Coffee')).toBeNull();                    // spending hidden
      expect(screen.queryByTestId('insights-bars-caption')).toBeNull();
    });

    it('switching back to Spending restores the category rows', async () => {
      seedSides(BOTH);
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      fireEvent.press(screen.getByTestId('insights-side-spending'));
      expect(screen.getByText('Cafes & Coffee')).toBeTruthy();
      expect(screen.queryByText('Salary')).toBeNull();
    });

    it('taps an income source into its transactions for the selected cycle', async () => {
      seedSides(BOTH);
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      fireEvent.press(screen.getByText('Salary'));
      expect(routerSpies.push).toHaveBeenCalledWith('/category/salary?cycle=0');
    });

    it('Earning with spend but no income sources shows the empty message, not a category row', async () => {
      // Old server (or all sources net ~$0): earned lifted but no per-source map. The toggle still
      // shows because spend is present; the Earning side is an honest empty, not a dead end.
      seedSides({ spend: { coffee: posted(40) }, earned: 3000 });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('No income yet this pay cycle.')).toBeTruthy();
      expect(screen.queryByText('Cafes & Coffee')).toBeNull();
    });

    it('shows a pending sub-line and a reversed (clawed-back) source correctly', async () => {
      seedSides({
        spend: { coffee: posted(40) },
        earned: 3150,
        income: { salary: { posted: 3000, pending: 250 }, dividends: posted(-100) },
      });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('$250 pending')).toBeTruthy();      // positive pending sub-line
      expect(screen.getByText('-$100')).toBeTruthy();             // clawback renders signed
    });

    it('falls back to an "Income" label when the taxonomy lacks the source id', async () => {
      seedSides({ spend: { coffee: posted(40) }, earned: 200, income: { mystery: posted(200) } });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Income')).toBeTruthy();
    });

    it('income-only cycle: toggle shows; default Spending reads empty; Earning lists the income', async () => {
      seedSides({ earned: 3000, income: { salary: posted(3000) } });
      await renderInsights();
      expect(screen.getByTestId('insights-side-earning')).toBeTruthy();           // toggle shows (income present)
      expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();    // default Spending is honest-empty
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Salary')).toBeTruthy();
    });

    it('no toggle and no drill press targets when the cycle is fully empty', async () => {
      seedSides({ earned: 0 });
      await renderInsights();
      expect(screen.queryByTestId('insights-side-spending')).toBeNull();          // nothing to switch to
      expect(screen.queryByTestId('insights-side-earning')).toBeNull();
      expect(screen.getByText('No spending yet this pay cycle.')).toBeTruthy();
      expect(screen.queryByTestId('earned-bar-press')).toBeNull();                // card is summary-only
      expect(screen.queryByTestId('spent-bar-press')).toBeNull();
    });
  });
});

describe('Insights earning share bars (WHIT-373)', () => {
  // The income share bars are inline Views filled with the SOURCE's chart-palette colour (WHIT chart
  // palette — each source its own colour, matching the pie, not a flat green). They're the only nodes
  // whose raw backgroundColor is a CATEGORY_COLORS hex: chips are rgba(tint) and the EarnedVsSpent card
  // bars are C.good/C.bad (not in the ramp), so neither matches. Collect each matching fill's width.
  const RAMP = new Set<string>(CATEGORY_COLORS);
  function incomeBarWidths(node: unknown, acc: string[] = []): string[] {
    if (!node || typeof node !== 'object') return acc;
    if (Array.isArray(node)) { node.forEach((n) => incomeBarWidths(n, acc)); return acc; }
    const n = node as { props: { style?: unknown; testID?: string }; children?: unknown[] };
    const flat = styleOf(n);
    if (RAMP.has(flat.backgroundColor)) {
      acc.push(String(flat.width));
    }
    if (Array.isArray(n.children)) n.children.forEach((c) => incomeBarWidths(c, acc));
    return acc;
  }

  describe('Insights "Earning" share bars (WHIT-373)', () => {
    // [B1] Two positive sources → two green bars sized by share of shown income (3000 vs 500 of 3500).
    // The bigger source's bar must be wider. FAIL-ON-REVERT: if barPct divided by `earned` (or dropped
    // the incomeShareTotal denominator) the widths change; if the guard let the plug/reversed rows bar,
    // the count changes.
    it('[B1] draws a proportional green bar per positive source, biggest widest', async () => {
      seedSides({ spend: { coffee: posted(20) }, earned: 3500, income: { salary: posted(3000), dividends: posted(500) } });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      const widths = incomeBarWidths(screen.toJSON());
      expect(widths).toHaveLength(2);
      // salary 3000/3500 ≈ 85.7% ; dividends 500/3500 ≈ 14.3%
      expect(parseFloat(widths[0])).toBeCloseTo((3000 / 3500) * 100, 5);
      expect(parseFloat(widths[1])).toBeCloseTo((500 / 3500) * 100, 5);
      expect(parseFloat(widths[0])).toBeGreaterThan(parseFloat(widths[1]));
    });

    // [B2] The muted reconcile plug is not a real source: it must render its label, get NO green bar,
    // and NOT be tappable. earned 3120 vs one 3000 source ⇒ a 120 plug. FAIL-ON-REVERT: wrapping the
    // muted row in a Pressable (drill) makes the press fire routerSpies.push; letting the plug bar makes the
    // width count 2.
    it('[B2] the muted reconcile plug gets no bar and does not drill', async () => {
      seedSides({ spend: { coffee: posted(40) }, earned: 3120, income: { salary: posted(3000) } });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Pending/refund adjustment')).toBeTruthy();
      // only the real source (salary) gets a green bar — the plug does not
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(1);
      // tapping the plug row navigates nowhere (it has no Pressable wrapper)
      fireEvent.press(screen.getByText('Pending/refund adjustment'));
      expect(routerSpies.push).not.toHaveBeenCalled();
      // the real source still drills
      fireEvent.press(screen.getByText('Salary'));
      expect(routerSpies.push).toHaveBeenCalledWith('/category/salary?cycle=0');
    });

    // [B3] Every source clawed back this cycle → the positive denominator is 0. Rows still render (as
    // −$X), but NO bar may be drawn — no div-by-zero, no NaN width. earned = shownAmount so no plug.
    // NOTE: double-guarded (the `incomeShareTotal > 0` denominator AND the per-row `r.amount > 0` gate),
    // so no single revert reddens this — it's a defensive regression guard, not a fail-on-revert test.
    it('[B3] an all-reversed cycle renders rows but zero bars (denominator 0 is safe)', async () => {
      seedSides({ earned: -300, income: { salary: posted(-200), dividends: posted(-100) } });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('-$200')).toBeTruthy();
      expect(screen.getByText('-$100')).toBeTruthy();
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(0); // no green bars at all
    });

    // [B4] Stale-side carry: a user on Earning who moves to a spend-only cycle keeps the toggle (spend
    // has content) and lands on an honest "No income" empty — never a blank, never a category row on
    // the Earning side. Documents the clamp's real behaviour (side = sideChoice while the toggle shows).
    it('[B4] Earning choice carried into a later spend-only cycle shows the income empty, toggle intact', async () => {
      seedSides({ spend: { coffee: posted(20) }, earned: 3500, income: { salary: posted(3000) } });
      await renderInsights();
      fireEvent.press(screen.getByTestId('insights-side-earning'));
      expect(screen.getByText('Salary')).toBeTruthy();
      // the other cycle's data arrives: spend only, no income sources
      server.once('GET', '/breakdown', { body: breakdownWire({ spend: { coffee: posted(20) }, earned: 0 }) });
      await showLastCycle();
      expect(screen.getByTestId('insights-side-earning')).toBeTruthy();        // toggle stays (spend present)
      expect(screen.getByText('No income in that pay cycle.')).toBeTruthy();    // honest (past-cycle) empty, not a spend row
      expect(screen.queryByText('Cafes & Coffee')).toBeNull();                 // still on Earning, spend hidden
      expect(incomeBarWidths(screen.toJSON())).toHaveLength(0);
    });
  });
});
