// Screen tests for the Home Loan Milestone screen (WHIT-8) and its entry point.
// WHIT-685: the live balance / loan facts / repayment / saved plan come from the fake server
// through the real screen data code (useGoalScreenData, and useMilestonesQuery for the editor),
// and the real milestoneView / goalView selectors run over them. A failed read is a 500 from
// the server; a still-loading one is a held reply. useAppContext is stubbed (these screens
// read only the editor's writers off it). expo-router's useRouter is mocked to capture navigation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent, act, within } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS, LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';
import type { MilestoneRecord } from '../api';
import { MoneyField } from '../components/MoneyField';
import { C } from '../theme';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// The Milestone/Mortgage screens don't read useAppContext (the real selectors still run
// via requireActual). The folded editor (milestoneEdit) DOES read saveMilestones/showToast
// off it, so the stub returns the superset object — inert for the screens that ignore it.
const mockSaveMilestones = jest.fn(async (_next: MilestoneRecord[]) => true);
const mockShowToast = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: mockSaveMilestones, showToast: mockShowToast }) };
});

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Milestone from '../../app/milestone';
import Mortgage from '../../app/mortgage';
import MilestoneEdit from '../../app/milestone/edit';

const server = installFakeServer();
useTestQueryClient();

// Loan facts are saved by default (property value + LVR set) so equity renders; pass
// EMPTY_LOAN_FACTS to exercise the "set this up" empty state.
beforeEach(() => {
  resetAuth();
  resetRouter();
  seedGoal(server);
});

// Draw without waiting, for a held (still-loading) reply.
function drawHeld(ui: React.ReactElement) {
  return render(<WithQueries>{ui}</WithQueries>);
}

// Let a held reply go and wait for it to land and redraw the screen, so nothing is left pending
// into the next test.
async function releaseAndSettle(held: { release: () => void }) {
  await act(async () => { held.release(); });
  await settle();
  await refreshInAct(() => {});
}

// --- the milestone screen ----------------------------------------------------

it('renders the live balance, the sprint plan, and usable equity', async () => {
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();       // hero balance
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  // The known-state body frames the source as the user's own home (not "the property"),
  // matching the retitled card. Fail-on-revert to "the property value".
  expect(screen.getByText(/your LVR × your home's value/)).toBeTruthy();
  // Sprint 0 is the next milestone at this balance, so its callout shows.
  expect(screen.getByText('under $544,000')).toBeTruthy();
  // WHIT-216 fail-on-revert: the sync pill's "Mon YYYY" label comes from milestone.tsx's
  // monthYear over the shared MONTHS array (asOf 2026-07-04 → Jul). A broken array swap
  // would change the month name here — previously this file had zero month-string coverage.
  expect(screen.getByText('Live · Up Home Loan · Jul 2026')).toBeTruthy();
});

it('shows a waiting state before the live balance has loaded', async () => {
  seedGoal(server, { homeLoan: { balance: null, asOf: null } });
  await renderWithQueries(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  // No fabricated balance while unknown.
  expect(screen.queryByText(/milestones reached/)).toBeNull();
});

it('shows an error + retry (not a permanent spinner) when the balance fetch failed', async () => {
  server.fail('/homeloan', 500);
  await renderWithQueries(<Milestone />);
  // Distinct from the waiting spinner — an honest failure message.
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
  // WHIT-121 #4 parity: the milestone Retry now carries the same a11y contract as the Goal-tab
  // ones (shared RetryButton). Assert the props so a regression on this copy is caught too.
  const retry = screen.getByTestId('milestone-balance-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your balance');
  expect(screen.getByText("Couldn't load your balance.").props.accessibilityLiveRegion).toBe('polite');
  await refreshInAct(() => fireEvent.press(retry));
  expect(server.sent('GET', '/homeloan')).toHaveLength(2);
});

it('does NOT show a balance error when only repayment/loanFacts failed (balance still loading)', async () => {
  // The aggregate isError is true, but the balance read itself is fine (homeLoanError
  // false) — the hero must show the spinner, not "Couldn't load your balance". Locks
  // the home-loan-scoped error (plan-critic #1): reverting milestone.tsx to key on the
  // aggregate isError turns this red.
  seedGoal(server, { homeLoan: { balance: null, asOf: null } });
  server.fail('/repayment', 500);
  server.fail('/loanfacts', 500);
  await renderWithQueries(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
});

// --- the mortgage-screen entry point ------------------------------------------------

it('navigates to /milestone from the mortgage screen Sprint summary', async () => {
  await renderWithQueries(<Mortgage />);
  fireEvent.press(screen.getByTestId('milestone-link'));
  expect(routerSpies.push).toHaveBeenCalledWith('/milestone');
});

it('Mortgage-screen Sprint summary shows real progress when the balance has loaded', async () => {
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  // Real Sprint model (from the live balance), not the old $50k chunks.
  expect(screen.getByText('0 of 5 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $544,000')).toBeTruthy();
  expect(screen.queryByText(/chunks cleared/)).toBeNull();
});

it('Mortgage-screen Sprint summary invites a tap before the balance loads', async () => {
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
  expect(screen.getByText('Tap to see your live progress')).toBeTruthy();
});

it('The mortgage equity card frames it as the home\'s equity, not a separate investment property', async () => {
  // The equity is computed from the user's OWN home (homeValue*lvr - balance), so the card
  // must read as "equity from your current home toward your next place" — NOT "Investment
  // property #2" with its own loan (the copy that confused a real user). Fail-on-revert: any
  // return to the old "#2" / "Landlord arc" framing turns this red.
  // A deposit target is set, so the card is in its "tracking progress" body.
  seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 120000 }, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
  expect(screen.getByText(/put toward your next place/)).toBeTruthy();   // the "known" body
  expect(screen.queryByText('Investment property #2')).toBeNull();
  expect(screen.queryByText(/Landlord arc/)).toBeNull();
});

// WHIT-378: the deposit target is the user's real number, not a hardcoded $90k.
it('equity card shows real progress toward the deposit target when one is set', async () => {
  // homeValue 770000 × lvr 0.8 = 616000; balance 566000 → equity 50000; target 100000 → 50%.
  seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$50,000 unlocked')).toBeTruthy();
  expect(screen.getByText('of $100,000 needed')).toBeTruthy();   // the user's real target, not $90,000
  expect(screen.getByText('50%')).toBeTruthy();
  expect(screen.queryByText('of $90,000 needed')).toBeNull();    // the old fake figure is gone
});

it('equity card degrades cleanly (no %, no bar, no fake "needed") when no deposit target is set', async () => {
  // Equity is known (facts + balance) but the user has set no target → honest prompt, no denominator.
  seedGoal(server, { homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$50,000 unlocked')).toBeTruthy();          // the real figure still shows
  expect(screen.getByText('Set deposit target →')).toBeTruthy();      // nudge instead of a fake bar
  expect(screen.queryByText(/needed/)).toBeNull();                    // no "of $X needed" denominator
  expect(screen.queryByText(/put toward your next place/)).toBeNull(); // not the target-set body
});

it('The mortgage screen shows a balance error + Retry when the balance read fails (WHIT-121 #2)', async () => {
  // WHIT-121 (#2): with loan facts SET, a homeLoan failure now surfaces an error + Retry on
  // the Goal hero instead of silently degrading to "—" — the Goal tab previously swallowed a
  // balance failure. Mirrors milestone.tsx. The projection stays hidden (no fake numbers).
  server.fail('/homeloan', 500);
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  await refreshInAct(() => fireEvent.press(screen.getByTestId('hero-balance-retry')));
  expect(server.sent('GET', '/homeloan')).toHaveLength(2);
});

// --- empty state (loan facts not set) ----------------------------------------

it('The mortgage screen shows a set-up prompt (not fake numbers) when loan facts are unset', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  // The real live balance still shows; the fabricated "$67,100 paid down" seed does not.
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // The facts-ready "PAID DOWN SO FAR" hero must NOT appear in the unset state.
  expect(screen.queryByText(/paid down so far/i)).toBeNull();
  expect(screen.queryByText('Mortgage-free')).toBeNull();  // seed projection hidden until set up
});

it('milestone screen shows an equity set-up prompt when the property value is unset', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Milestone />);
  // Balance + sprint plan still render (they only need the live balance)...
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
  // ...but equity is a prompt, not a fabricated figure.
  expect(screen.getByText(/Add your home's value/)).toBeTruthy();
  fireEvent.press(screen.getByText('Add loan details →'));
  expect(routerSpies.push).toHaveBeenCalledWith('/loan');
});

// --- equity card copy: gap coverage (empty-state body, CTA routing, milestone subtitle) ---

it('mortgage equity card empty-state uses the reworded prompt, not the old property framing', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText(/Add your home's value/)).toBeTruthy();
  expect(screen.queryByText(/Add your property value/)).toBeNull();
  expect(screen.queryByText('Investment property #2')).toBeNull();
});

it('mortgage equity card "Add loan details →" routes to /loan', async () => {
  // Two CTAs render in the empty state (hero "Set up loan details →" + equity "Add loan
  // details →"); this locks the equity one specifically.
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Mortgage />);
  fireEvent.press(screen.getByText('Add loan details →'));
  expect(routerSpies.push).toHaveBeenCalledWith('/loan');
});

it('milestone equity card known-state shows the current-home subtitle, not "Investment property #2"', async () => {
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Milestone />);
  expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
  expect(screen.queryByText('Investment property #2')).toBeNull();
  expect(screen.queryByText(/Usable equity toward a deposit/)).toBeNull();
});

// --- mortgage-screen last-repayment card (WHIT-115) ---------------------------------

it('The mortgage screen shows the real last repayment (amount + date + split), no fake timestamp', async () => {
  seedGoal(server, {
    // A distinct amount (not 1440) so it doesn't collide with the contribution
    // card's "$1,440" (baseRepay 1240 + extra 200) now the leading "−" is gone.
    repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 },
  });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText(/Last repayment ·/)).toBeTruthy();
  expect(screen.getByText('$1,268 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,500')).toBeTruthy();   // plain positive — a repayment toward the goal, not a debit
  // The old hardcoded seed timestamp must be gone.
  expect(screen.queryByText(/9:02am/)).toBeNull();
});

it('The mortgage screen shows a graceful empty state when there is no repayment on record', async () => {
  seedGoal(server, { repayment: { amount: null, date: null, principal: null, interest: null } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});

// ===== WHIT-367 (folded from milestoneReadpath.screen.test.tsx) =====
// The milestone read path: the screen renders the user's SAVED plan when one exists, the
// built-in default when it doesn't. SAVED_PLAN is block-scoped here since it's used only by
// these two cases.
describe('WHIT-367 milestone read path', () => {
  const SAVED_PLAN: MilestoneRecord[] = [
    { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
    { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
    { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
  ];

  it('renders the saved milestone plan when one exists', async () => {
    seedGoal(server, { milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } });
    await renderWithQueries(<Milestone />);
    // The user's own rows — label + step number derived from position.
    expect(screen.getByText('Sprint 0 · Start')).toBeTruthy();
    expect(screen.getByText('Sprint 1 · Midway')).toBeTruthy();
    expect(screen.getByText('under $300,000 · Jan 2026')).toBeTruthy();
    // The built-in default plan's rows must NOT appear once a saved plan is present.
    expect(screen.queryByText('Sprint 0 · Kickoff')).toBeNull();
    expect(screen.queryByText('under $544,000 · Jun 2026')).toBeNull();
  });

  it('shows the empty "add milestones" state when no milestones are saved', async () => {
    seedGoal(server, { milestones: [], homeLoan: { balance: 596642.43, asOf: null } });
    await renderWithQueries(<Milestone />);
    // No hardcoded default any more — a user who hasn't set a plan gets an invite, not fake sprints.
    expect(screen.getByText(/You haven't set any milestones yet/)).toBeTruthy();
    expect(screen.getByText('Add milestones')).toBeTruthy();
    expect(screen.queryByText('Sprint 0 · Kickoff')).toBeNull();
    expect(screen.queryByText(/milestones reached/)).toBeNull();
  });
});

// ===== WHIT-8 GAP (folded from milestoneCleared.screen.test.tsx) =====
// The fully-cleared state — every Sprint target reached. The "NEXT MILESTONE" callout must
// disappear (nextMilestone null gates it) and the hero reports "5 of 5 milestones reached".
// This sibling originally mocked NO ../context; under the fold it inherits the survivor's
// ../context stub. Verified inert: Milestone never calls useAppContext (it reads the real
// milestoneView selector, still supplied via requireActual), so the stubbed useAppContext
// return is ignored.
it('hides the NEXT MILESTONE callout once every target is cleared', async () => {
  // 40000 is below the Sprint 4 target (55000): all five milestones cleared.
  seedGoal(server, { homeLoan: { balance: 40000, asOf: '2029-07-01T00:00:00.000Z' } });
  await renderWithQueries(<Milestone />);

  expect(screen.getByText('5 of 5 milestones reached')).toBeTruthy();
  // No next target to chase => the callout and its "to go" line are gone.
  expect(screen.queryByText('NEXT MILESTONE')).toBeNull();
  expect(screen.queryByText(/to go$/)).toBeNull();
});

// ===== WHIT-197 GAP (folded from milestoneHero.edges.screen.test.tsx) =====
// The milestone hero state machine: a KNOWN (last-good, cached) balance while the balance
// read is itself in an error state. hasBalance must WIN — show the last-good balance + plan
// and swallow the refetch error.
it('a known (last-good) balance WINS over a refetch error — shows the balance, not the error', async () => {
  // TanStack keeps the last successful `data` when a refetch errors, so homeLoan.balance stays
  // present while the read is in error. hasBalance must take precedence.
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  await renderWithQueries(<Milestone />);
  server.fail('/homeloan', 500);
  await refreshInAct(() => queryClient.refetchQueries());
  expect(server.sent('GET', '/homeloan')).toHaveLength(2);
  expect(screen.getByText('$596,642')).toBeTruthy();                 // last-good balance still shown
  expect(screen.getByText('Your payoff plan')).toBeTruthy();        // plan still renders
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull(); // error is swallowed, not surfaced
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
});

// ===== WHIT-377 (folded from milestoneEdit.screen.test.tsx) =====
// The milestone editor screen. It reads the saved plan from the fake server's /milestones; the
// shared ../context mock supplies saveMilestones/showToast, and expo-router's back is
// routerSpies.back. The editor-only fixtures (SAVED, labelAt, its own beforeEach seeding the
// saved plan) are block-scoped here.
describe('WHIT-377 milestone editor', () => {
  const SAVED: MilestoneRecord[] = [
    { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
    { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
    { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
  ];

  const labelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

  beforeEach(() => {
    mockSaveMilestones.mockClear();
    mockShowToast.mockClear();
    server.seed('/milestones', SAVED);
  });

  it('hydrates the rows from the saved plan', async () => {
    await renderWithQueries(<MilestoneEdit />);
    expect(labelAt(0)).toBe('Start');
    expect(labelAt(1)).toBe('Midway');
    expect(labelAt(2)).toBe('Payoff');
  });

  it('a resolved new user starts with one blank row + a "Use a suggested plan" button', async () => {
    server.seed('/milestones', []);   // resolved, no saved plan
    await renderWithQueries(<MilestoneEdit />);
    expect(labelAt(0)).toBe('');
    expect(screen.queryByTestId('milestone-label-1')).toBeNull();       // exactly one blank row
    expect(screen.getByTestId('milestone-use-template')).toBeTruthy();  // the opt-in template button
  });

  it('"Use a suggested plan" loads the built-in template as editable rows', async () => {
    server.seed('/milestones', []);
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-use-template'));
    // The 5-sprint suggested plan is now in the form, editable (fail-on-revert: a blank seed only).
    expect(labelAt(0)).toBe('Kickoff');
    expect(labelAt(4)).toBe('Target');
  });

  it('a user with a saved plan is NOT offered the suggested-plan button (no accidental wipe)', async () => {
    await renderWithQueries(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-use-template')).toBeNull();
  });

  it('add appends a new blank row', async () => {
    await renderWithQueries(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-label-3')).toBeNull();
    fireEvent.press(screen.getByTestId('milestone-add'));
    expect(screen.getByTestId('milestone-label-3').props.value).toBe('');
  });

  it('delete removes a row', async () => {
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-delete-1')); // remove 'Midway'
    expect(labelAt(0)).toBe('Start');
    expect(labelAt(1)).toBe('Payoff');
    expect(screen.queryByTestId('milestone-label-2')).toBeNull();
  });

  it('hides Delete on the last remaining row (an empty plan is not savable)', async () => {
    server.seed('/milestones', [SAVED[0]]);
    await renderWithQueries(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-delete-0')).toBeNull();
  });

  it('blocks save while the saved plan is unresolved (undefined), even when not loading', async () => {
    // A settled read error leaves data undefined with isLoading false: the editor shows the DEFAULT,
    // so saving now would overwrite a real saved plan the user has. Save must be blocked until the
    // query resolves. Fail-on-revert for the `unloaded = saved === undefined` guard (isLoading is
    // false here, so an isLoading-based guard would wrongly let this save through).
    server.fail('/milestones', 500);
    await renderWithQueries(<MilestoneEdit />);
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });

  it('the down arrow swaps a row with its neighbour', async () => {
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-down-0')); // Start ↓ past Midway
    expect(labelAt(0)).toBe('Midway');
    expect(labelAt(1)).toBe('Start');
  });

  it('blocks save on an invalid order — toasts, flags the row inline, and does NOT call the writer', async () => {
    await renderWithQueries(<MilestoneEdit />);
    // Swapping the first two rows leaves Start (300k, 2026) BELOW Midway (200k, 2027): the second
    // row now rises in balance → out of order.
    fireEvent.press(screen.getByTestId('milestone-down-0'));
    expect(screen.getByText(/out of order/i)).toBeTruthy(); // live inline warning
    fireEvent.press(screen.getByTestId('milestone-save'));
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/lower balance and a later date/i));
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });

  it('a valid save hands the full plan to saveMilestones and navigates back', async () => {
    await renderWithQueries(<MilestoneEdit />);
    // Flush the in-flight guard's async action.
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
    const sent = mockSaveMilestones.mock.calls[0][0];
    expect(sent.map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
    expect(sent.map((m) => m.targetBalance)).toEqual([300000, 200000, 100000]);
    expect(routerSpies.back).toHaveBeenCalled();
  });

  // ===== WHIT-377 adversarial gaps (folded in) — cold-cache hydrate race + reorder bounds =====

  describe('cold-cache hydrate race', () => {
    it('while the read is still loading: shows one blank row and blocks save', async () => {
      const held = server.hold('/milestones');      // cold cache — nothing resolved yet
      drawHeld(<MilestoneEdit />);

      // One blank row — NOT the old hardcoded default plan (removed).
      expect(labelAt(0)).toBe('');
      expect(screen.queryByTestId('milestone-label-1')).toBeNull();  // exactly one row

      // Save is blocked while unloaded: pressing it must NOT write a plan.
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(mockSaveMilestones).not.toHaveBeenCalled();
      await releaseAndSettle(held);
    });

    it('when the real saved plan resolves: the seeded latch re-seeds the rows AND unblocks save', async () => {
      const held = server.hold('/milestones');
      drawHeld(<MilestoneEdit />);
      expect(labelAt(0)).toBe(''); // one blank row first (no hardcoded default)

      // The read resolves with the user's actual plan.
      await releaseAndSettle(held);

      // Re-seeded to the real plan (not left on the default).
      expect(labelAt(0)).toBe('Start');
      expect(labelAt(1)).toBe('Midway');
      expect(labelAt(2)).toBe('Payoff');

      // And save now goes through (a valid plan) — the block lifted with the load.
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
      expect(mockSaveMilestones.mock.calls[0][0].map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
    });
  });

  describe('reorder bounds are unreachable', () => {
    // The swap can never go out of bounds because the boundary arrows are DISABLED — that's the
    // honest, testable contract (a disabled Pressable swallows the press, so a "press does nothing"
    // test would pass even with moveRow's guard removed). moveRow keeps a bounds guard as cheap
    // defence, but it's UI-unreachable, so we assert the disabled state that makes it so.
    it('↑ on the first row is disabled', async () => {
      await renderWithQueries(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-up-0')).toBeDisabled();
    });

    it('↓ on the last row is disabled', async () => {
      await renderWithQueries(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-down-2')).toBeDisabled();
    });

    it('a mid-list arrow is enabled (the disable is boundary-specific, not blanket)', async () => {
      await renderWithQueries(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-up-1')).not.toBeDisabled();
    });
  });

  // WHIT-774: the TARGET BALANCE box is the shared MoneyField, tagged milestone-balance-N.
  describe('target balance box', () => {
    it("each row's balance box is the shared money box, tagged per row, and keeps the darker background", async () => {
      await renderWithQueries(<MilestoneEdit />);
      const fields = screen.UNSAFE_getAllByType(MoneyField);
      expect(fields).toHaveLength(SAVED.length);
      const input = within(fields[0]).getByTestId('milestone-balance-0');
      expect(input.props.value).toBe('300000');
      // Sign-off option A: the box stays C.bg so it contrasts with the C.card row card.
      let box = input.parent;
      while (box && !StyleSheet.flatten(box.props.style)?.backgroundColor) box = box.parent;
      expect(StyleSheet.flatten(box?.props.style).backgroundColor).toBe(C.bg);
    });

    it('user can type a new target balance and save it', async () => {
      await renderWithQueries(<MilestoneEdit />);
      fireEvent.changeText(screen.getByTestId('milestone-balance-0'), '600000');
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
      const sent = mockSaveMilestones.mock.calls[0][0];
      expect(sent.map((m) => m.targetBalance)).toEqual([600000, 200000, 100000]);
    });
  });
});

// ===== WHIT QA GAPS (empty-milestones / removed hardcoded default) =====
// Adversarial gaps the implementer's tests leave open: the DETAIL hero when hasPlan is false
// but a balance IS loaded (must render the balance cleanly, no rows[last] crash / no schedule
// pill / no "0 of 0"), and the editor's suggested-plan button end-to-end (SAVE persists the
// template) + its absence during a cold load + the blank-seed save guard.
describe('WHIT-459 empty-milestones gaps', () => {
  // A no-plan user with a LOADED balance: the hero shows the live balance and the "add milestones"
  // invite — and must NOT touch rows[last] (rows is []), render a progress bar, a "N of M
  // milestones reached" line, a "target $X", or a NEXT MILESTONE card. Fail-on-revert: drop the
  // `v.hasPlan &&` guard around the hero block in milestone.tsx and rows[last] throws.
  it('milestone detail hero renders the live balance cleanly when no plan is set (no crash, no schedule pill)', async () => {
    seedGoal(server, { milestones: [], homeLoan: { balance: 596642.43, asOf: null } });
    await renderWithQueries(<Milestone />);
    expect(screen.getByText('$596,642')).toBeTruthy();                 // live balance still shown
    expect(screen.getByText(/You haven't set any milestones yet/)).toBeTruthy(); // empty invite
    expect(screen.queryByText(/milestones reached/)).toBeNull();       // no "N of M" hero line
    expect(screen.queryByText(/target \$/)).toBeNull();                // no heroRowR "target $X"
    expect(screen.queryByText('NEXT MILESTONE')).toBeNull();           // nextMilestone is null
    expect(screen.queryByText('Sprint 0 · Kickoff')).toBeNull();       // no fabricated sprints
  });
});

// Editor gaps: same module-level mocks; a minimal labelAt + a beforeEach that clears the
// writer spy; the top-level resetRouter clears nav (the WHIT-377 describe's beforeEach is out of scope here).
describe('WHIT-459 suggested-plan gaps (editor)', () => {
  const labelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

  beforeEach(() => {
    mockSaveMilestones.mockClear();
  });

  // Loading the suggested plan then SAVING must persist the template rows end-to-end through
  // saveMilestones — not just fill the form. Fail-on-revert: revert templateRows() to a blank seed
  // (or block the save) and saveMilestones is called with the wrong rows / not at all.
  it('"Use a suggested plan" then Save persists the 5 template rows via saveMilestones', async () => {
    server.seed('/milestones', []);
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-use-template'));
    expect(labelAt(0)).toBe('Kickoff');
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
    const sent = mockSaveMilestones.mock.calls[0][0];
    expect(sent.map((m: { label: string }) => m.label)).toEqual(['Kickoff', 'Quarter way', 'Halfway', 'Three-quarters', 'Target']);
    expect(sent.map((m: { targetBalance: number }) => m.targetBalance)).toEqual([544000, 420000, 295000, 170000, 55000]);
    await Promise.resolve();
    expect(routerSpies.back).toHaveBeenCalled();
  });

  // During a COLD load (saved === undefined) the suggested-plan button must NOT render — offering
  // it before the plan resolves could clobber a real saved plan when the re-seed latch fires.
  // Fail-on-revert: change the gate to `saved === undefined || saved.length === 0`.
  it('does NOT offer the suggested-plan button during a cold load (saved undefined)', async () => {
    server.seed('/milestones', []);
    const held = server.hold('/milestones');
    drawHeld(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-use-template')).toBeNull();
    // Once the empty plan lands, the button appears: the cold load alone was hiding it.
    await releaseAndSettle(held);
    expect(screen.getByTestId('milestone-use-template')).toBeTruthy();
  });
});

describe('WHIT-459 blank-seed save guard (editor)', () => {
  const labelAt = (i: number) => screen.getByTestId(`milestone-label-${i}`).props.value;

  beforeEach(() => {
    mockSaveMilestones.mockClear();
    mockShowToast.mockClear();
  });

  // A resolved new user (saved === []) opens on ONE BLANK row. Tapping Save WITHOUT filling it must
  // be blocked by the shared ordering/validation guard (blank name) — a toast, and NO write of a
  // NaN-balance / empty-label milestone. Fail-on-revert: revert seedRows to templateRows() for []
  // (a valid default would save instead of blocking).
  it('a new user tapping Save on the blank seed row is blocked (toast, no write)', async () => {
    server.seed('/milestones', []);
    await renderWithQueries(<MilestoneEdit />);
    expect(labelAt(0)).toBe('');                                   // opens blank, not a default plan
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(mockSaveMilestones).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/name|target|date/i));
  });
});
