// WHIT-233 — the Goals hub screen (app/(tabs)/goals). Locks: the empty state, real goal
// cards (progress %, pace, paydays from the actual balanceGoalView engine over injected
// useGoalsScreenData), the always-present mortgage card (balance / mortgageError / tap-through),
// loading + primary-error states, and every navigation target (the "+" and cards route to
// /goal/edit, the mortgage card to /mortgage). ScrollChromeHeader is mocked to a passthrough
// (its clearance/scroll wiring is covered by tabScreens*); the REAL balanceGoalView runs, so a
// selector revert reddens the % / pace assertions. Clock pinned to Sat 11 Jul 2026 so the
// pay-cycle pace is deterministic (matches the balanceGoal.logic fixtures).
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';

// Passthrough header so the hub's content (and its `right` action) render without the
// NavBarsProvider the real ScrollChromeHeader needs.
jest.mock('../motion/ScrollChromeHeader', () => {
  const { View, Text } = require('react-native');
  return {
    ScrollChromeHeader: ({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) => (
      <View><Text>{title}</Text>{right}{children}</View>
    ),
  };
});

let mockData: ReturnType<typeof baseData>;
jest.mock('../queries', () => ({ useGoalsScreenData: () => mockData }));

// WHIT-235: the hub now calls useAppContext for openGoalBalance. Keep the real balanceGoalView
// (the % / pace assertions run the real engine); only the writer boundary is stubbed.
const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ openGoalBalance: mockOpenGoalBalance }) };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: () => {},
}));

import Goals from '../../app/(tabs)/goals';

const PAY_CYCLE = { length: 14, last_pay_date: '2026-06-06' }; // paydays …Jul18, Aug1, Aug15
const GROW = { id: 'g1', name: 'Emergency fund', icon: 'wallet', direction: 'grow', target_amount: 10000, target_date: '2026-08-15', account_id: 'up-spending' };
const PAYDOWN = { id: 'g2', name: 'Car loan', icon: 'car', direction: 'paydown', target_amount: 0, target_date: '2026-08-15', baseline: 20000, manual_balance: 12000, manual_as_of: '2026-07-01', account_id: null };
// WHIT-296: a fully-populated LoanFacts (all six numbers) so loanFactsReady is true and the
// mortgage card takes its rich payoff branch. `original` sits well above the default balance
// (596,642) so paid-down is a sensible positive figure.
const READY_FACTS = { original: 800000, homeValue: 900000, lvr: 0.8, ratePct: 5.74, baseRepay: 1240, extra: 200, payoffGoalDate: null };

function baseData(over: Record<string, unknown> = {}) {
  return {
    goals: [] as unknown[],
    payCycle: PAY_CYCLE,
    balanceFor: (id: string | null | undefined) => (id === 'up-spending' ? 4000 : null),
    loanFacts: { original: null, homeValue: null, lvr: null, ratePct: null, baseRepay: null, extra: null },
    homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:00:00Z' },
    mortgageError: false,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockOpenGoalBalance.mockClear();
  jest.useFakeTimers({ now: new Date(2026, 6, 11) }); // Sat 11 Jul 2026
  mockData = baseData();
});
afterEach(() => { jest.useRealTimers(); });

describe('empty state (WHIT-295: the mortgage IS a goal)', () => {
  it('shows the mortgage as the headline goal + an additive invite — never "No goals yet"', () => {
    render(<Goals />);
    expect(screen.getByTestId('mortgage-link')).toBeTruthy(); // the headline goal, always shown
    expect(screen.getByTestId('add-goal-cta')).toBeTruthy();
    // The additive invite replaces the old contradictory "No goals yet" card.
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(screen.queryByText('No goals yet')).toBeNull();
    expect(screen.queryByTestId('goals-empty')).toBeNull();
  });

  it('lists the mortgage UNDER the "YOUR GOALS" heading (it counts as a goal)', () => {
    render(<Goals />);
    expect(screen.getByText('YOUR GOALS')).toBeTruthy();
    expect(within(screen.getByTestId('mortgage-link')).getByText('The mortgage')).toBeTruthy();
  });
});

describe('goal cards (real balanceGoalView)', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW, PAYDOWN] }); });

  it('renders a grow goal: 40% there, $2,000/payday, 3 paydays left', () => {
    render(<Goals />);
    expect(screen.getByText('Emergency fund')).toBeTruthy();
    expect(screen.getByText('Saving toward $10,000 · by Aug 2026')).toBeTruthy();
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('$2,000 / payday')).toBeTruthy();
    expect(card.getByText('3 paydays left')).toBeTruthy();
  });

  it('renders a paydown goal: 40% paid off, $4,000/payday', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(screen.getByText('Paying down $0 · by Aug 2026')).toBeTruthy();
    expect(card.getByText('40%')).toBeTruthy();
    expect(card.getByText('$4,000 / payday')).toBeTruthy();
  });

  it('a synced goal with no live balance yet shows "—" and a waiting label, not a crash', () => {
    mockData = baseData({ goals: [GROW], balanceFor: () => null }); // account not polled
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByText('—')).toBeTruthy();
    expect(card.getByText('Waiting on your balance')).toBeTruthy();
  });

  // WHIT-478: the "N of M reached" checkpoint line.
  it('shows "N of M reached" for a goal with checkpoints (grow, balance 4000)', () => {
    // GROW balance 4000; rungs 2000/4000/6000/8000 → 2000 and 4000 reached.
    const withLadder = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 4000 }, { id: 'c', label: 'C', amount: 6000 }, { id: 'd', label: 'D', amount: 8000 }] };
    mockData = baseData({ goals: [withLadder] });
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.getByTestId('goal-checkpoints-g1')).toHaveTextContent('2 of 4 reached');
  });

  it('a goal with no checkpoints renders NO checkpoint line (unchanged from today)', () => {
    render(<Goals />); // GROW + PAYDOWN, neither has a ladder
    expect(screen.queryByTestId('goal-checkpoints-g1')).toBeNull();
    expect(screen.queryByTestId('goal-checkpoints-g2')).toBeNull();
    // and the existing card content is untouched
    expect(within(screen.getByTestId('goal-card-g1')).getByText('$2,000 / payday')).toBeTruthy();
  });

  it('hides the checkpoint line for a synced goal whose balance is not polled yet', () => {
    const withLadder = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }] };
    mockData = baseData({ goals: [withLadder], balanceFor: () => null });
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByTestId('goal-checkpoints-g1')).toBeNull();
    expect(card.getByText('Waiting on your balance')).toBeTruthy();
  });

  // WHIT-478 QA gaps: the "0 of N" and "N of N" ends, and coexistence with the Update-balance row.
  it('shows "0 of N reached" when the balance has passed no rungs yet', () => {
    const g = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 5000 }, { id: 'b', label: 'B', amount: 8000 }] };
    mockData = baseData({ goals: [g] }); // balance 4000, both rungs above → 0 reached
    render(<Goals />);
    expect(within(screen.getByTestId('goal-card-g1')).getByTestId('goal-checkpoints-g1')).toHaveTextContent('0 of 2 reached');
  });

  it('shows "N of N reached" when every rung is passed', () => {
    const g = { ...GROW, checkpoints: [{ id: 'a', label: 'A', amount: 2000 }, { id: 'b', label: 'B', amount: 3000 }] };
    mockData = baseData({ goals: [g] }); // balance 4000, both below → 2 of 2
    render(<Goals />);
    expect(within(screen.getByTestId('goal-card-g1')).getByTestId('goal-checkpoints-g1')).toHaveTextContent('2 of 2 reached');
  });

  it('a manual paydown shows the reached-count AND keeps the "Update balance" row', () => {
    const g = { ...PAYDOWN, checkpoints: [{ id: 'a', label: 'A', amount: 15000 }, { id: 'b', label: 'B', amount: 10000 }] };
    mockData = baseData({ goals: [g] }); // owed 12000 → ≤15000 reached, ≤10000 not → 1 of 2
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(card.getByTestId('goal-checkpoints-g2')).toHaveTextContent('1 of 2 reached');
    expect(card.getByTestId('goal-balance-g2')).toBeTruthy();
    expect(card.getByText('Update balance')).toBeTruthy();
  });
});

describe('the mortgage card', () => {
  it('shows the balance owing when the home loan has loaded', () => {
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('$596,642 owing')).toBeTruthy();
  });

  it('a SECONDARY mortgage failure still shows the card (tap to open), never blanks the hub', () => {
    mockData = baseData({ homeLoan: { balance: null, asOf: null }, mortgageError: true });
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('Tap to open your payoff plan')).toBeTruthy();
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy(); // hub still renders its goals section
  });
});

// WHIT-296: once loan facts + balance are known the card mirrors the /mortgage hero. Real
// goalView runs (the suite keeps the real selectors), so the payoff numbers are computed for
// real and a selector revert reddens these.
describe('the mortgage card — rich payoff state', () => {
  it('shows the hero payoff detail: paid-down figure, % gone, to-go, and started-at', () => {
    mockData = baseData({ loanFacts: READY_FACTS }); // original 800k, balance 596,642 → 25% gone
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(card.getByText('$203,358')).toBeTruthy();       // 800,000 − 596,642
    expect(card.getByText('25% gone')).toBeTruthy();        // 203,358 / 800,000
    expect(card.getByText('$596,642 to go')).toBeTruthy();
    expect(card.getByText('started at $800,000')).toBeTruthy();
    expect(card.queryByText(/owing/)).toBeNull();           // no longer the plain line
  });

  it('the rich card still routes into the full mortgage screen on tap', () => {
    mockData = baseData({ loanFacts: READY_FACTS });
    render(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(mockPush).toHaveBeenCalledWith('/mortgage');
  });

  it('a fully-paid loan (balance $0) reads "100% gone", never rounded down', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 0, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('100% gone')).toBeTruthy();
    expect(card.getByText('$800,000')).toBeTruthy(); // the whole original is paid down
    expect(card.getByText('$0 to go')).toBeTruthy();
  });

  it('a tiny balance still owing never rounds up to "100% gone"', () => {
    // 799,000 of 800,000 paid → 99.875%. Must read 99, not a "100% gone" beside "$1,000 to go".
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 1000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('99% gone')).toBeTruthy();
    expect(card.getByText('$1,000 to go')).toBeTruthy();
  });

  it('a balance AT or ABOVE the original shows the plain "owing" line, not a nonsense $0 rich card', () => {
    // original 500k below the 596,642 balance → no genuine paydown to show; the rich card would
    // read "$0 paid" next to "owe more than you started", so it must fall through to the plain line.
    mockData = baseData({ loanFacts: { ...READY_FACTS, original: 500000 } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642 owing')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
  });

  it('facts ready but balance not loaded yet degrades to the plain "tap to see" line', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: null, asOf: null } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('Tap to see your payoff plan')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull(); // not the rich state
  });
});

describe('loading + error', () => {
  it('shows a spinner while loading with nothing cached', () => {
    mockData = baseData({ isLoading: true });
    render(<Goals />);
    expect(screen.getByTestId('goals-loading')).toBeTruthy();
    expect(screen.queryByTestId('goals-empty-hint')).toBeNull();
  });

  it('shows an error + Retry when a PRIMARY read fails with nothing cached', () => {
    const refetch = jest.fn();
    mockData = baseData({ isError: true, refetch });
    render(<Goals />);
    expect(screen.getByTestId('goals-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('goals-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps showing goals when isError but rows are cached (cache-first)', () => {
    mockData = baseData({ goals: [GROW], isError: true });
    render(<Goals />);
    expect(screen.queryByTestId('goals-error')).toBeNull();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
  });
});

describe('navigation', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW] }); });

  it('the "+" routes to the goal add screen', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('add-goal'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit');
  });

  it('a goal card routes to the edit screen with its id', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('goal-card-g1'));
    expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=g1');
  });

  it('the mortgage card routes to the full mortgage screen', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('mortgage-link'));
    expect(mockPush).toHaveBeenCalledWith('/mortgage');
  });
});

describe('manual goal balance (WHIT-235)', () => {
  beforeEach(() => { mockData = baseData({ goals: [GROW, PAYDOWN] }); });

  it('a MANUAL goal shows its "as of" date + an Update balance affordance', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g2'));
    expect(card.getByText('Balance as of 1 Jul 2026')).toBeTruthy();
    expect(card.getByTestId('goal-balance-g2')).toBeTruthy();
  });

  it('a SYNCED goal shows neither the "as of" line nor the affordance', () => {
    render(<Goals />);
    const card = within(screen.getByTestId('goal-card-g1'));
    expect(card.queryByTestId('goal-balance-g1')).toBeNull();
    expect(card.queryByText(/Balance as of/)).toBeNull();
  });

  it('tapping Update balance opens the balance sheet for that goal', () => {
    render(<Goals />);
    fireEvent.press(screen.getByTestId('goal-balance-g2'));
    expect(mockOpenGoalBalance).toHaveBeenCalledWith('g2');
    // (The card-body-still-navigates complement is goalsHubBalanceGaps [A17]; RNTL never bubbles
    // an inner press to the parent, so asserting "no push" here would pass tautologically.)
  });

  it('flags a balance not updated in over 30 days as stale', () => {
    mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g3', manual_as_of: '2026-05-01' }] }); // 71 days before
    render(<Goals />);
    expect(within(screen.getByTestId('goal-card-g3')).getByText('Haven’t updated in a while')).toBeTruthy();
  });

  it('does NOT flag a recently-updated balance', () => {
    render(<Goals />); // PAYDOWN as-of 2026-07-01, 10 days before the pinned clock
    expect(within(screen.getByTestId('goal-card-g2')).queryByText('Haven’t updated in a while')).toBeNull();
  });
});

// ===== WHIT-235 (folded from goalsHubBalanceGaps.screen.test.tsx) =====
// GAP tests for the manual-balance affordance: the stale BOUNDARY (30 vs 31 days), a manual goal
// with NO as-of date ("Balance not set"), and the regression that tapping the card BODY of a
// manual goal still routes to edit despite the nested "Update balance" button. Same harness
// (identical mocks + baseData), so these run at module scope alongside the suite above.

// [A14] the stale threshold is "> 30 days". Exactly 30 days old must NOT flag; 31 days must. The
// implementer only tested 71 days (stale) and 10 days (fresh) — neither pins the boundary, so an
// off-by-one (>= vs >) would pass their suite. 2026-06-11 is 30 days before the pinned clock.
it('does NOT flag a balance exactly 30 days old (boundary, not > 30)', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g30', manual_as_of: '2026-06-11' }] });
  render(<Goals />);
  expect(within(screen.getByTestId('goal-card-g30')).queryByText('Haven’t updated in a while')).toBeNull();
});

// [A15] the matching over-boundary case.
it('flags a balance 31 days old (just over the boundary)', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'g31', manual_as_of: '2026-06-10' }] });
  render(<Goals />);
  expect(within(screen.getByTestId('goal-card-g31')).getByText('Haven’t updated in a while')).toBeTruthy();
});

// [A16] a manual goal with NO as-of date shows "Balance not set" (never a crash / blank / "as of
// undefined") and is not flagged stale. balanceIsStale(null) short-circuits to false.
it('a manual goal with a null as-of shows "Balance not set" and no stale tag', () => {
  mockData = baseData({ goals: [{ ...PAYDOWN, id: 'gnull', manual_as_of: null }] });
  render(<Goals />);
  const card = within(screen.getByTestId('goal-card-gnull'));
  expect(card.getByText('Balance not set')).toBeTruthy();
  expect(card.queryByText(/Balance as of/)).toBeNull();
  expect(card.queryByText('Haven’t updated in a while')).toBeNull();
});

// [A17] REGRESSION: adding the nested "Update balance" button inside the card must not steal taps
// on the card body — tapping the card (not the button) still routes to the edit screen, and the
// sheet does NOT open. Mirrors the existing synced-card nav test, but for a MANUAL card.
it('tapping a manual goal card body still routes to edit (not the sheet)', () => {
  mockData = baseData({ goals: [PAYDOWN] });
  render(<Goals />);
  fireEvent.press(screen.getByTestId('goal-card-g2'));
  expect(mockPush).toHaveBeenCalledWith('/goal/edit?id=g2');
  expect(mockOpenGoalBalance).not.toHaveBeenCalled();
});

// ===== WHIT-296 (folded from goalsHubRichGaps.screen.test.tsx) =====
// GAP tests for the rich-payoff mortgage card: adversarial boundaries the implementer's
// `describe('the mortgage card — rich payoff state')` leaves open. Same harness (identical mocks +
// baseData, REAL goalView), so every payoff number is computed for real.
describe('WHIT-296 rich mortgage card — gap boundaries', () => {
  // [G2] balance EXACTLY equal to the original: the natural zero boundary — paidOff is genuinely 0,
  // so there's no honest paydown to headline. The card must fall through to the plain "owing" line,
  // not show an empty "$0 / 0% gone" rich card. This is the exact edge of the `paidDown > 0` gate.
  it('[G2] balance exactly equal to original → the plain "owing" line, not an empty rich card', () => {
    mockData = baseData({ loanFacts: { ...READY_FACTS, original: 596642.43 } }); // == default balance
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$596,642 owing')).toBeTruthy();
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
  });

  // [G3] "% gone" must ROUND, not floor/truncate. 205,000 / 800,000 = 25.625% → 26%. A floor or
  // trunc would render "25% gone", so this reddens if Math.round is swapped for Math.floor.
  it('[G3] paidPct that lands on x.625 rounds UP to the next whole percent', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 595000, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$205,000')).toBeTruthy();       // 800,000 − 595,000
    expect(card.getByText('26% gone')).toBeTruthy();        // 25.625 → 26 (round, not 25)
    expect(card.getByText('$595,000 to go')).toBeTruthy();
  });

  // [G4] with real goals present the rich mortgage must still LEAD the list (it's the headline
  // goal). Compare serialized render order — React renders children in array order, so the
  // mortgage-link testID must appear before goal-card-g1's.
  it('[G4] the rich mortgage card renders BEFORE the real goal cards', () => {
    mockData = baseData({ loanFacts: READY_FACTS, goals: [GROW] });
    render(<Goals />);
    // both present
    expect(within(screen.getByTestId('mortgage-link')).getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByTestId('goal-card-g1')).toBeTruthy();
    // ordering
    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf('"mortgage-link"')).toBeGreaterThanOrEqual(0);
    expect(tree.indexOf('"mortgage-link"')).toBeLessThan(tree.indexOf('"goal-card-g1"'));
  });

  // [G5] rich mortgage + an EMPTY goals list: the additive invite (goals-empty-hint) must still
  // coexist — entering the rich state must not suppress it or resurrect "No goals yet".
  it('[G5] rich mortgage coexists with the empty-list invite (never "No goals yet")', () => {
    mockData = baseData({ loanFacts: READY_FACTS, goals: [] });
    render(<Goals />);
    expect(within(screen.getByTestId('mortgage-link')).getByText('PAID DOWN SO FAR')).toBeTruthy();
    expect(screen.getByTestId('goals-empty-hint')).toBeTruthy();
    expect(screen.queryByText('No goals yet')).toBeNull();
  });

  // [G6] a SUB-DOLLAR paydown must NOT headline the rich card: paidOff = 0.30 would pass a raw
  // `paidDown > 0` gate, but fmt(0.30) rounds to "$0" → the "$0 paid down" nonsense. The gate
  // rounds to whole dollars (like fmt), so a 30c paydown stays on the plain "owing" line.
  it('[G6] a 30c paydown shows the plain owing line, not a "$0 paid down" rich card', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 799999.70, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.queryByText('PAID DOWN SO FAR')).toBeNull();
    expect(card.getByText('$800,000 owing')).toBeTruthy();
  });

  // [G7] a residual-cents balance that DISPLAYS as "$0 to go" must read "100% gone", not 99 — the
  // 100% branch keys off the rounded balance so the label agrees with the "$0 to go" figure.
  it('[G7] a 43c residual balance ("$0 to go") reads 100% gone, not 99%', () => {
    mockData = baseData({ loanFacts: READY_FACTS, homeLoan: { balance: 0.43, asOf: '2026-07-04T00:00:00Z' } });
    render(<Goals />);
    const card = within(screen.getByTestId('mortgage-link'));
    expect(card.getByText('$0 to go')).toBeTruthy();
    expect(card.getByText('100% gone')).toBeTruthy();
  });
});
