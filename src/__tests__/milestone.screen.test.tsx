// Screen tests for the Home Loan Milestone screen (WHIT-8) and its entry point.
// WHIT-685: the live balance / loan facts / repayment / saved plan come from the fake server
// through the real screen data code (useGoalScreenData, and useMilestonesQuery for the editor),
// and the real milestoneView / goalView selectors run over them. A failed read is a 500 from
// the server; a still-loading one is a held reply. useAppContext is stubbed (these screens
// read only the editor's writers off it). expo-router's useRouter is mocked to capture navigation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, within, waitFor } from '@testing-library/react-native';
import { EMPTY_LOAN_FACTS, LOAN_FACTS } from './factory';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, renderWithQueries, useTestQueryClient, drawHeld, releaseAndSettle, WithQueries, settle } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { seedGoal, EQUITY_TEASER } from './support/goalsScreen';
import { routerSpies, resetRouter } from './support/routerMock';
import { queryClient } from '../queryClient';
import { saveMilestonesSpy, showToastSpy, milestoneLabelAt } from './support/milestoneEditor';
import { SAVED_MILESTONES } from './support/milestonePlan';

jest.mock('../auth', () => require('./support/authMock').authMockModule());

// The Milestone/Mortgage screens ignore this stub; the folded editor reads saveMilestones/showToast off it.
jest.mock('../context', () => require('./support/milestoneEditor').milestoneEditorContextMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Milestone from '../../app/milestone';
import Mortgage from '../../app/mortgage';
import MilestoneEdit from '../../app/milestone/edit';

const server = installFakeServer();
useTestQueryClient();

const AS_OF = '2026-07-04T00:24:37.614Z';

// Loan facts are saved by default (property value + LVR set) so equity renders; pass
// EMPTY_LOAN_FACTS to exercise the "set this up" empty state.
beforeEach(() => {
  resetAuth();
  resetRouter();
  seedGoal(server);
});

// --- the milestone screen ----------------------------------------------------

it('renders the live balance, the sprint plan, and usable equity', async () => {
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: AS_OF } });
  await renderWithQueries(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();       // hero balance
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  // The known-state body frames the source as the user's own home (not "the property"),
  // matching the retitled card. Fail-on-revert to "the property value".
  expect(screen.getByText(/your LVR × your home's value/)).toBeTruthy();
  // Sprint 0 is the next milestone at this balance, so its callout shows.
  expect(screen.getByText('under $544,000')).toBeTruthy();
  // WHIT-216 fail-on-revert: the shared balance pill's "D Mon" label reads the shared MONTHS
  // array (asOf 2026-07-04 → Jul). A broken array swap would change the month name here.
  // WHIT-822: the pill is the shared "As of <day>" one, no hard-coded bank name.
  expect(within(screen.getByTestId('balance-freshness')).getByText('As of 4 Jul')).toBeTruthy();
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
  await refreshInAct(() => fireEvent.press(screen.getByTestId('milestone-balance-retry')));
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

// WHIT-378: the deposit target is the user's real number, not a hardcoded $90k.
it('equity card shows real progress toward the deposit target when one is set', async () => {
  // homeValue 770000 × lvr 0.8 = 616000; balance 566000 → equity 50000; target 100000 → 50%.
  seedGoal(server, { loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: AS_OF } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText('$50,000 unlocked')).toBeTruthy();
  expect(screen.getByText('of $100,000 needed')).toBeTruthy();   // the user's real target, not $90,000
  expect(screen.getByText('50%')).toBeTruthy();
});

it('[A10] (P0) Mortgage "Set deposit target →" still opens the loan form', async () => {
  seedGoal(server, { homeLoan: { balance: 566000, asOf: AS_OF } });
  await renderWithQueries(<Mortgage />);
  fireEvent.press(screen.getByText('Set deposit target →'));
  expect(routerSpies.push).toHaveBeenCalledWith('/loan');
});

it('equity card degrades cleanly (no %, no bar, no fake "needed") when no deposit target is set', async () => {
  // Equity is known (facts + balance) but the user has set no target → honest prompt, no denominator.
  seedGoal(server, { homeLoan: { balance: 566000, asOf: AS_OF } });
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
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: AS_OF } });
  await renderWithQueries(<Mortgage />);
  // The real live balance still shows; the fabricated "$67,100 paid down" seed does not.
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // The facts-ready "PAID DOWN SO FAR" hero must NOT appear in the unset state.
  expect(screen.queryByText(/paid down so far/i)).toBeNull();
  expect(screen.queryByText('Mortgage-free')).toBeNull();  // seed projection hidden until set up
});

it('milestone screen shows an equity set-up prompt when the property value is unset', async () => {
  seedGoal(server, { loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: AS_OF } });
  await renderWithQueries(<Milestone />);
  // Balance + sprint plan still render (they only need the live balance)...
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Your payoff plan')).toBeTruthy();
  // ...but equity is a teaser, not a fabricated figure. WHIT-821: no button — set-up lives on
  // the Home loan screen's top card.
  expect(screen.getByText(EQUITY_TEASER)).toBeTruthy();
  expect(screen.queryByText('Add loan details →')).toBeNull();
});

it('WHIT-819: milestone screen hides the equity set-up prompt while loan facts load', async () => {
  const held = server.hold('/loanfacts');
  drawHeld(<Milestone />);
  await screen.findByText('Your payoff plan'); // the balance has landed; only the facts are held
  expect(screen.queryByText(EQUITY_TEASER)).toBeNull();
  await releaseAndSettle(held);
});

// --- equity card copy: gap coverage (empty-state body, CTA routing, milestone subtitle) ---

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
});

it('The mortgage screen shows a graceful empty state when there is no repayment on record', async () => {
  seedGoal(server, { repayment: { amount: null, date: null, principal: null, interest: null } });
  await renderWithQueries(<Mortgage />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});

// ===== WHIT-367 (folded from milestoneReadpath.screen.test.tsx) =====
// The milestone read path: the screen renders the user's SAVED plan when one exists, the
// built-in default when it doesn't.
describe('WHIT-367 milestone read path', () => {
  it('renders the saved milestone plan when one exists', async () => {
    seedGoal(server, { milestones: SAVED_MILESTONES, homeLoan: { balance: 250000, asOf: null } });
    await renderWithQueries(<Milestone />);
    // The user's own rows, by the name the user gave each one.
    expect(screen.getByText('Start')).toBeTruthy();
    expect(screen.getByText('Midway')).toBeTruthy();
    expect(screen.getByText('under $300,000 · Jan 2026')).toBeTruthy();
    // The built-in default plan's rows must NOT appear once a saved plan is present.
    expect(screen.queryByText('Kickoff')).toBeNull();
    expect(screen.queryByText('under $544,000 · Jun 2026')).toBeNull();
  });
});

// ===== WHIT-197 GAP (folded from milestoneHero.edges.screen.test.tsx) =====
// The milestone hero state machine: a KNOWN (last-good, cached) balance while the balance
// read is itself in an error state. hasBalance must WIN — show the last-good balance + plan
// and swallow the refetch error.
it('a known (last-good) balance WINS over a refetch error — shows the balance, not the error', async () => {
  // TanStack keeps the last successful `data` when a refetch errors, so homeLoan.balance stays
  // present while the read is in error. hasBalance must take precedence.
  seedGoal(server, { homeLoan: { balance: 596642.43, asOf: AS_OF } });
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
// routerSpies.back. Its own beforeEach seeds the saved plan.
describe('WHIT-377 milestone editor', () => {
  beforeEach(() => {
    saveMilestonesSpy.mockClear();
    showToastSpy.mockClear();
    server.seed('/milestones', SAVED_MILESTONES);
  });

  it('a resolved new user starts with one blank row + a "Use a suggested plan" button', async () => {
    server.seed('/milestones', []);   // resolved, no saved plan
    await renderWithQueries(<MilestoneEdit />);
    expect(milestoneLabelAt(0)).toBe('');
    expect(screen.queryByTestId('milestone-label-1')).toBeNull();       // exactly one blank row
    expect(screen.getByTestId('milestone-use-template')).toBeTruthy();  // the opt-in template button
  });

  it('a user with a saved plan is NOT offered the suggested-plan button (no accidental wipe)', async () => {
    await renderWithQueries(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-use-template')).toBeNull();
  });

  it('delete removes a row', async () => {
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-delete-1')); // remove 'Midway'
    expect(milestoneLabelAt(0)).toBe('Start');
    expect(milestoneLabelAt(1)).toBe('Payoff');
    expect(screen.queryByTestId('milestone-label-2')).toBeNull();
  });

  it('hides Delete on the last remaining row (an empty plan is not savable)', async () => {
    server.seed('/milestones', [SAVED_MILESTONES[0]]);
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
    expect(saveMilestonesSpy).not.toHaveBeenCalled();
  });

  it('the down arrow swaps a row with its neighbour', async () => {
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-down-0')); // Start ↓ past Midway
    expect(milestoneLabelAt(0)).toBe('Midway');
    expect(milestoneLabelAt(1)).toBe('Start');
  });

  it('blocks save on an invalid order — toasts, flags the row inline, and does NOT call the writer', async () => {
    await renderWithQueries(<MilestoneEdit />);
    // Swapping the first two rows leaves Start (300k, 2026) BELOW Midway (200k, 2027): the second
    // row now rises in balance → out of order.
    fireEvent.press(screen.getByTestId('milestone-down-0'));
    expect(screen.getByText(/out of order/i)).toBeTruthy(); // live inline warning
    fireEvent.press(screen.getByTestId('milestone-save'));
    expect(showToastSpy).toHaveBeenCalledWith(expect.stringMatching(/lower balance and a later date/i));
    expect(saveMilestonesSpy).not.toHaveBeenCalled();
  });

  it('a valid save hands the full plan to saveMilestones and navigates back', async () => {
    await renderWithQueries(<MilestoneEdit />);
    // Flush the in-flight guard's async action.
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(saveMilestonesSpy).toHaveBeenCalledTimes(1);
    const sent = saveMilestonesSpy.mock.calls[0][0];
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
      expect(milestoneLabelAt(0)).toBe('');
      expect(screen.queryByTestId('milestone-label-1')).toBeNull();  // exactly one row

      // Save is blocked while unloaded: pressing it must NOT write a plan.
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(saveMilestonesSpy).not.toHaveBeenCalled();
      await releaseAndSettle(held);
    });

    it('when the real saved plan resolves: the seeded latch re-seeds the rows AND unblocks save', async () => {
      const held = server.hold('/milestones');
      drawHeld(<MilestoneEdit />);
      expect(milestoneLabelAt(0)).toBe(''); // one blank row first (no hardcoded default)

      // The read resolves with the user's actual plan.
      await releaseAndSettle(held);

      // Re-seeded to the real plan (not left on the default).
      expect(milestoneLabelAt(0)).toBe('Start');
      expect(milestoneLabelAt(1)).toBe('Midway');
      expect(milestoneLabelAt(2)).toBe('Payoff');

      // And save now goes through (a valid plan) — the block lifted with the load.
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(saveMilestonesSpy).toHaveBeenCalledTimes(1);
      expect(saveMilestonesSpy.mock.calls[0][0].map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
    });
  });

  // WHIT-774: the TARGET BALANCE box is the shared MoneyField, tagged milestone-balance-N.
  describe('target balance box', () => {
    it('user can type a new target balance and save it', async () => {
      await renderWithQueries(<MilestoneEdit />);
      fireEvent.changeText(screen.getByTestId('milestone-balance-0'), '600000');
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(saveMilestonesSpy).toHaveBeenCalledTimes(1);
      const sent = saveMilestonesSpy.mock.calls[0][0];
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
    expect(screen.queryByText('Kickoff')).toBeNull();       // no fabricated sprints
  });
});

// Editor gaps: same module-level mocks; a beforeEach that clears the
// writer spy; the top-level resetRouter clears nav (the WHIT-377 describe's beforeEach is out of scope here).
describe('WHIT-459 suggested-plan gaps (editor)', () => {
  beforeEach(() => {
    saveMilestonesSpy.mockClear();
  });

  // Loading the suggested plan then SAVING must persist the template rows end-to-end through
  // saveMilestones — not just fill the form. Fail-on-revert: revert templateRows() to a blank seed
  // (or block the save) and saveMilestones is called with the wrong rows / not at all.
  it('"Use a suggested plan" then Save persists the 5 template rows via saveMilestones', async () => {
    server.seed('/milestones', []);
    await renderWithQueries(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-use-template'));
    expect(milestoneLabelAt(0)).toBe('Kickoff');
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(saveMilestonesSpy).toHaveBeenCalledTimes(1);
    const sent = saveMilestonesSpy.mock.calls[0][0];
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
  beforeEach(() => {
    saveMilestonesSpy.mockClear();
    showToastSpy.mockClear();
  });

  // A resolved new user (saved === []) opens on ONE BLANK row. Tapping Save WITHOUT filling it must
  // be blocked by the shared ordering/validation guard (blank name) — a toast, and NO write of a
  // NaN-balance / empty-label milestone. Fail-on-revert: revert seedRows to templateRows() for []
  // (a valid default would save instead of blocking).
  it('a new user tapping Save on the blank seed row is blocked (toast, no write)', async () => {
    server.seed('/milestones', []);
    await renderWithQueries(<MilestoneEdit />);
    expect(milestoneLabelAt(0)).toBe('');                                   // opens blank, not a default plan
    await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
    expect(saveMilestonesSpy).not.toHaveBeenCalled();
    expect(showToastSpy).toHaveBeenCalledWith(expect.stringMatching(/name|target|date/i));
  });
});

describe('the mortgage and milestone screens over the fake server', () => {
  // [A5] the balance's FIRST load still in flight: the waiting copy, never the error or a number.
  it('[A5] mortgage hero waits (no error, no balance) while the first balance read is held, then shows it', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    const held = server.hold('/homeloan');
    render(<WithQueries><Mortgage /></WithQueries>);
    await waitFor(() => expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy());
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.queryByText('$67,100')).toBeNull();

    await act(async () => { held.release(); });
    await settle();
    await refreshInAct(() => {});
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.queryByText("We'll show your payoff progress once your balance loads.")).toBeNull();
  });

  // [A9] the repayment card's Retry recovers to the real card.
  it('[A9] repayment Retry after a failed first load shows the real repayment card', async () => {
    seedGoal(server, { repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 } });
    server.once('GET', '/repayment', { status: 500 });
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("Couldn't load your last repayment.")).toBeTruthy();

    await refreshInAct(() => fireEvent.press(screen.getByTestId('repayment-retry')));
    await settle();
    await refreshInAct(() => {});
    expect(screen.queryByText("Couldn't load your last repayment.")).toBeNull();
    expect(screen.getByText('$1,268 principal · $232 interest')).toBeTruthy();
  });

  // [A10] milestones are SECONDARY: a failed plan read never blanks the balance hero or shows a
  // balance error; the Sprint summary shows its own milestones error, not the invite (WHIT-823).
  it('[A10] a failed milestones read keeps the mortgage balance and shows the milestones error', async () => {
    seedGoal(server, { homeLoan: { balance: 432900, asOf: AS_OF } });
    server.fail('/milestones', 500);
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText('$67,100')).toBeTruthy();
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
    expect(screen.getByText("Couldn't load your milestones.")).toBeTruthy();
  });

  // [A10b] the same with the balance not polled yet (null): the hero must stay on the waiting copy,
  // the only state where a milestones failure leaking into the balance error would show.
  it('[A10b] a failed milestones read never turns the waiting balance hero into a balance error', async () => {
    seedGoal(server, { homeLoan: { balance: null, asOf: null } });
    server.fail('/milestones', 500);
    await renderWithQueries(<Mortgage />);
    expect(screen.getByText("We'll show your payoff progress once your balance loads.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
  });
});

describe('the milestone editor over the fake server', () => {
  // [A12] the seeded latch: once rows are filled from the saved plan, a background refetch that
  // brings a different plan must not wipe the user's edits.
  it('[A12] a background refetch after hydration does not overwrite the rows being edited', async () => {
    server.seed('/milestones', SAVED_MILESTONES);
    await renderWithQueries(<MilestoneEdit />);
    expect(milestoneLabelAt(0)).toBe('Start');
    fireEvent.changeText(screen.getByTestId('milestone-label-0'), 'Typed');

    server.seed('/milestones', [{ id: 'z', label: 'Server', targetBalance: 50000, targetDate: '2030-01-01' }]);
    await refreshInAct(() => queryClient.refetchQueries());
    expect(server.sent('GET', '/milestones')).toHaveLength(2);
    expect(milestoneLabelAt(0)).toBe('Typed');
    expect(milestoneLabelAt(1)).toBe('Midway');
  });
});
