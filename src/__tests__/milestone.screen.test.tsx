// Screen tests for the Home Loan Milestone screen (WHIT-8) and its entry point.
// WHIT-197: the live balance / loan facts / repayment now come from the cached query
// layer via useGoalScreenData(), so that hook is mocked (the real milestoneView /
// goalView selectors still run over the mocked composite data). ../context stays
// partially mocked so the real selectors run; useAppContext is stubbed empty (these
// screens don't read it). expo-router's useRouter is mocked to capture navigation.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { makeGoalData, EMPTY_LOAN_FACTS, LOAN_FACTS } from './factory';
import type { GoalScreenData } from '../queries';
import type { MilestoneRecord } from '../api';

// The composite the two screens now read (makeGoalData is typed off the real
// GoalScreenData). `homeLoanError` is the balance read's OWN error, kept separate from
// the aggregate isError (a repayment/loanFacts failure must not masquerade as a balance
// error).
let mockGoal: GoalScreenData;
// WHIT-459 fold: mocks reconciled to a SUPERSET so the folded editor cluster shares them.
// useGoalScreenData drives the Milestone/Mortgage screens; useMilestonesQuery/useIsAuthed
// drive the editor (milestoneEdit fold). Each screen reads only its own hook, so the
// unused entries are inert per test.
let mockSaved: MilestoneRecord[] | undefined;
let mockIsLoading: boolean;
jest.mock('../queries', () => ({
  useGoalScreenData: () => mockGoal,
  useIsAuthed: () => true,
  useMilestonesQuery: () => ({ data: mockSaved, isLoading: mockIsLoading }),
}));

// The Milestone/Mortgage screens don't read useAppContext (the real selectors still run
// via requireActual). The folded editor (milestoneEdit) DOES read saveMilestones/showToast
// off it, so the stub returns the superset object — inert for the screens that ignore it.
const mockSaveMilestones = jest.fn(async (_next: MilestoneRecord[]) => true);
const mockShowToast = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ saveMilestones: mockSaveMilestones, showToast: mockShowToast }) };
});

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useFocusEffect: () => {},
}));

import Milestone from '../../app/milestone';
import Mortgage from '../../app/mortgage';
import MilestoneEdit from '../../app/milestone/edit';

// Loan facts are saved by default (property value + LVR set) so equity renders; pass
// EMPTY_LOAN_FACTS to exercise the "set this up" empty state.
beforeEach(() => {
  mockPush.mockClear();
  mockGoal = makeGoalData();
});

// --- the milestone screen ----------------------------------------------------

it('renders the live balance, the sprint plan, and usable equity', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();       // hero balance
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
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

it('shows a waiting state before the live balance has loaded', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null } });
  render(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  // No fabricated balance while unknown.
  expect(screen.queryByText(/milestones reached/)).toBeNull();
});

it('shows an error + retry (not a permanent spinner) when the balance fetch failed', () => {
  const refetch = jest.fn();
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, isError: true, refetch });
  render(<Milestone />);
  // Distinct from the waiting spinner — an honest failure message.
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
  // WHIT-121 #4 parity: the milestone Retry now carries the same a11y contract as the Goal-tab
  // ones (shared RetryButton). Assert the props so a regression on this copy is caught too.
  const retry = screen.getByTestId('milestone-balance-retry');
  expect(retry.props.accessibilityRole).toBe('button');
  expect(retry.props.accessibilityLabel).toBe('Retry loading your balance');
  expect(screen.getByText("Couldn't load your balance.").props.accessibilityLiveRegion).toBe('polite');
  fireEvent.press(retry);
  expect(refetch).toHaveBeenCalled();
});

it('does NOT show a balance error when only repayment/loanFacts failed (balance still loading)', () => {
  // The aggregate isError is true, but the balance read itself is fine (homeLoanError
  // false) — the hero must show the spinner, not "Couldn't load your balance". Locks
  // the home-loan-scoped error (plan-critic #1): reverting milestone.tsx to key on the
  // aggregate isError turns this red.
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: false, isError: true });
  render(<Milestone />);
  expect(screen.getByText('Fetching your live balance…')).toBeTruthy();
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull();
});

// --- the mortgage-screen entry point ------------------------------------------------

it('navigates to /milestone from the mortgage screen Sprint summary', () => {
  render(<Mortgage />);
  fireEvent.press(screen.getByTestId('milestone-link'));
  expect(mockPush).toHaveBeenCalledWith('/milestone');
});

it('Mortgage-screen Sprint summary shows real progress when the balance has loaded', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  // Real Sprint model (from the live balance), not the old $50k chunks.
  expect(screen.getByText('0 of 5 sprints reached')).toBeTruthy();
  expect(screen.getByText('Next: under $544,000')).toBeTruthy();
  expect(screen.queryByText(/chunks cleared/)).toBeNull();
});

it('Mortgage-screen Sprint summary invites a tap before the balance loads', () => {
  render(<Mortgage />);
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  expect(screen.getByText('Tap to see your live progress')).toBeTruthy();
});

it('The mortgage equity card frames it as the home\'s equity, not a separate investment property', () => {
  // The equity is computed from the user's OWN home (homeValue*lvr - balance), so the card
  // must read as "equity from your current home toward your next place" — NOT "Investment
  // property #2" with its own loan (the copy that confused a real user). Fail-on-revert: any
  // return to the old "#2" / "Landlord arc" framing turns this red.
  // A deposit target is set, so the card is in its "tracking progress" body.
  mockGoal = makeGoalData({ loanFacts: { ...LOAN_FACTS, depositTarget: 120000 }, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText('Equity for your next place')).toBeTruthy();
  expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
  expect(screen.getByText(/put toward your next place/)).toBeTruthy();   // the "known" body
  expect(screen.queryByText('Investment property #2')).toBeNull();
  expect(screen.queryByText(/Landlord arc/)).toBeNull();
});

// WHIT-378: the deposit target is the user's real number, not a hardcoded $90k.
it('equity card shows real progress toward the deposit target when one is set', () => {
  // homeValue 770000 × lvr 0.8 = 616000; balance 566000 → equity 50000; target 100000 → 50%.
  mockGoal = makeGoalData({ loanFacts: { ...LOAN_FACTS, depositTarget: 100000 }, homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText('$50,000 unlocked')).toBeTruthy();
  expect(screen.getByText('of $100,000 needed')).toBeTruthy();   // the user's real target, not $90,000
  expect(screen.getByText('50%')).toBeTruthy();
  expect(screen.queryByText('of $90,000 needed')).toBeNull();    // the old fake figure is gone
});

it('equity card degrades cleanly (no %, no bar, no fake "needed") when no deposit target is set', () => {
  // Equity is known (facts + balance) but the user has set no target → honest prompt, no denominator.
  mockGoal = makeGoalData({ homeLoan: { balance: 566000, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText('$50,000 unlocked')).toBeTruthy();          // the real figure still shows
  expect(screen.getByText('Set deposit target →')).toBeTruthy();      // nudge instead of a fake bar
  expect(screen.queryByText(/needed/)).toBeNull();                    // no "of $X needed" denominator
  expect(screen.queryByText(/put toward your next place/)).toBeNull(); // not the target-set body
});

it('The mortgage screen shows a balance error + Retry when the balance read fails (WHIT-121 #2)', () => {
  // WHIT-121 (#2): with loan facts SET, a homeLoan failure now surfaces an error + Retry on
  // the Goal hero instead of silently degrading to "—" — the Goal tab previously swallowed a
  // balance failure. Mirrors milestone.tsx. The projection stays hidden (no fake numbers).
  const refetch = jest.fn();
  mockGoal = makeGoalData({ homeLoan: { balance: null, asOf: null }, homeLoanError: true, isError: true, refetch });
  render(<Mortgage />);
  expect(screen.getByText("Couldn't load your balance.")).toBeTruthy();
  expect(screen.queryByText('Mortgage-free')).toBeNull();
  fireEvent.press(screen.getByTestId('hero-balance-retry'));
  expect(refetch).toHaveBeenCalledTimes(1);
});

// --- empty state (loan facts not set) ----------------------------------------

it('The mortgage screen shows a set-up prompt (not fake numbers) when loan facts are unset', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  // The real live balance still shows; the fabricated "$67,100 paid down" seed does not.
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('Set up loan details →')).toBeTruthy();
  // The facts-ready "PAID DOWN SO FAR" hero must NOT appear in the unset state.
  expect(screen.queryByText(/paid down so far/i)).toBeNull();
  expect(screen.queryByText('Mortgage-free')).toBeNull();  // seed projection hidden until set up
});

it('milestone screen shows an equity set-up prompt when the property value is unset', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  // Balance + sprint plan still render (they only need the live balance)...
  expect(screen.getByText('$596,642')).toBeTruthy();
  expect(screen.getByText('The 36-month plan')).toBeTruthy();
  // ...but equity is a prompt, not a fabricated figure.
  expect(screen.getByText(/Add your home's value/)).toBeTruthy();
  fireEvent.press(screen.getByText('Add loan details →'));
  expect(mockPush).toHaveBeenCalledWith('/loan');
});

// --- equity card copy: gap coverage (empty-state body, CTA routing, milestone subtitle) ---

it('mortgage equity card empty-state uses the reworded prompt, not the old property framing', () => {
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  expect(screen.getByText(/Add your home's value/)).toBeTruthy();
  expect(screen.queryByText(/Add your property value/)).toBeNull();
  expect(screen.queryByText('Investment property #2')).toBeNull();
});

it('mortgage equity card "Add loan details →" routes to /loan', () => {
  // Two CTAs render in the empty state (hero "Set up loan details →" + equity "Add loan
  // details →"); this locks the equity one specifically.
  mockGoal = makeGoalData({ loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Mortgage />);
  fireEvent.press(screen.getByText('Add loan details →'));
  expect(mockPush).toHaveBeenCalledWith('/loan');
});

it('milestone equity card known-state shows the current-home subtitle, not "Investment property #2"', () => {
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' } });
  render(<Milestone />);
  expect(screen.getByText('Usable equity from your current home')).toBeTruthy();
  expect(screen.queryByText('Investment property #2')).toBeNull();
  expect(screen.queryByText(/Usable equity toward a deposit/)).toBeNull();
});

// --- mortgage-screen last-repayment card (WHIT-115) ---------------------------------

it('The mortgage screen shows the real last repayment (amount + date + split), no fake timestamp', () => {
  mockGoal = makeGoalData({
    // A distinct amount (not 1440) so it doesn't collide with the contribution
    // card's "$1,440" (baseRepay 1240 + extra 200) now the leading "−" is gone.
    repayment: { amount: 1500, date: '2026-07-01', principal: 1268, interest: 232 },
  });
  render(<Mortgage />);
  expect(screen.getByText(/Last repayment ·/)).toBeTruthy();
  expect(screen.getByText('$1,268 principal · $232 interest')).toBeTruthy();
  expect(screen.getByText('$1,500')).toBeTruthy();   // plain positive — a repayment toward the goal, not a debit
  // The old hardcoded seed timestamp must be gone.
  expect(screen.queryByText(/9:02am/)).toBeNull();
});

it('The mortgage screen shows a graceful empty state when there is no repayment on record', () => {
  mockGoal = makeGoalData({ repayment: { amount: null, date: null, principal: null, interest: null } });
  render(<Mortgage />);
  expect(screen.getByText(/No repayment on record yet/)).toBeTruthy();
});

// ===== WHIT-367 (folded from milestoneReadpath.screen.test.tsx) =====
// The milestone read path: the screen renders the user's SAVED plan when one exists, the
// built-in default when it doesn't. useGoalScreenData is already mocked above (the real
// milestoneView selector still runs over the mocked composite); SAVED_PLAN is block-scoped
// here since it's used only by these two cases. beforeEach re-seed of mockGoal is inherited
// from the module-level one.
describe('WHIT-367 milestone read path', () => {
  const SAVED_PLAN: MilestoneRecord[] = [
    { id: 'a', label: 'Start',  targetBalance: 300000, targetDate: '2026-01-01' },
    { id: 'b', label: 'Midway', targetBalance: 200000, targetDate: '2027-01-01' },
    { id: 'c', label: 'Payoff', targetBalance: 100000, targetDate: '2028-01-01' },
  ];

  it('renders the saved milestone plan when one exists', () => {
    mockGoal = makeGoalData({ milestones: SAVED_PLAN, homeLoan: { balance: 250000, asOf: null } });
    render(<Milestone />);
    // The user's own rows — label + step number derived from position.
    expect(screen.getByText('Sprint 0 · Start')).toBeTruthy();
    expect(screen.getByText('Sprint 1 · Midway')).toBeTruthy();
    expect(screen.getByText('under $300,000 · Jan 2026')).toBeTruthy();
    // The built-in default plan's rows must NOT appear once a saved plan is present.
    expect(screen.queryByText('Sprint 0 · Kickoff')).toBeNull();
    expect(screen.queryByText('under $544,000 · Jun 2026')).toBeNull();
  });

  it('falls back to the built-in default plan when no milestones are saved', () => {
    mockGoal = makeGoalData({ milestones: [], homeLoan: { balance: 596642.43, asOf: null } });
    render(<Milestone />);
    // The default 5-sprint plan still renders — a user who hasn't edited sees no change.
    expect(screen.getByText('Sprint 0 · Kickoff')).toBeTruthy();
    expect(screen.getByText('Sprint 4 · Target')).toBeTruthy();
  });
});

// ===== WHIT-8 GAP (folded from milestoneCleared.screen.test.tsx) =====
// The fully-cleared state — every Sprint target reached. The "NEXT MILESTONE" callout must
// disappear (nextMilestone null gates it) and the hero reports "5 of 5 milestones reached".
// This sibling originally mocked NO ../context; under the fold it inherits the survivor's
// ../context stub. Verified inert: Milestone never calls useAppContext (it reads the real
// milestoneView selector, still supplied via requireActual), so the stubbed useAppContext
// return is ignored. The test seeds its own mockGoal, so the module beforeEach is moot here.
it('hides the NEXT MILESTONE callout once every target is cleared', () => {
  // 40000 is below the Sprint 4 target (55000): all five milestones cleared.
  mockGoal = makeGoalData({ homeLoan: { balance: 40000, asOf: '2029-07-01T00:00:00.000Z' } });
  render(<Milestone />);

  expect(screen.getByText('5 of 5 milestones reached')).toBeTruthy();
  // No next target to chase => the callout and its "to go" line are gone.
  expect(screen.queryByText('NEXT MILESTONE')).toBeNull();
  expect(screen.queryByText(/to go$/)).toBeNull();
});

// ===== WHIT-197 GAP (folded from milestoneHero.edges.screen.test.tsx) =====
// The milestone hero state machine: a KNOWN (last-good, cached) balance while the balance
// read is itself in an error state. hasBalance must WIN — show the last-good balance + plan
// and swallow the refetch error. Mocks are identical to the survivor's; mockGoal is re-seeded
// by the module beforeEach (the test overrides it anyway).
it('a known (last-good) balance WINS over a refetch error — shows the balance, not the error', () => {
  // TanStack keeps the last successful `data` when a refetch errors, so homeLoan.balance is
  // present AND homeLoanError is true simultaneously. hasBalance must take precedence.
  mockGoal = makeGoalData({ homeLoan: { balance: 596642.43, asOf: '2026-07-04T00:24:37.614Z' }, homeLoanError: true, isError: true });
  render(<Milestone />);
  expect(screen.getByText('$596,642')).toBeTruthy();                 // last-good balance still shown
  expect(screen.getByText('The 36-month plan')).toBeTruthy();        // plan still renders
  expect(screen.queryByText("Couldn't load your balance.")).toBeNull(); // error is swallowed, not surfaced
  expect(screen.queryByText('Fetching your live balance…')).toBeNull();
});

// ===== WHIT-377 (folded from milestoneEdit.screen.test.tsx) =====
// The milestone editor screen. Its mocks needed a SUPERSET reconciliation at module scope:
// useMilestonesQuery/useIsAuthed were added to the shared ../queries mock, useAppContext to
// the shared ../context mock returns saveMilestones/showToast, and expo-router's back is the
// shared mockBack. The editor-only fixtures (SAVED, labelAt, its own beforeEach seeding
// mockSaved/mockIsLoading) are block-scoped here.
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
    mockBack.mockClear();
    mockSaved = SAVED;
    mockIsLoading = false;
  });

  it('hydrates the rows from the saved plan', () => {
    render(<MilestoneEdit />);
    expect(labelAt(0)).toBe('Start');
    expect(labelAt(1)).toBe('Midway');
    expect(labelAt(2)).toBe('Payoff');
  });

  it('add appends a new blank row', () => {
    render(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-label-3')).toBeNull();
    fireEvent.press(screen.getByTestId('milestone-add'));
    expect(screen.getByTestId('milestone-label-3').props.value).toBe('');
  });

  it('delete removes a row', () => {
    render(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-delete-1')); // remove 'Midway'
    expect(labelAt(0)).toBe('Start');
    expect(labelAt(1)).toBe('Payoff');
    expect(screen.queryByTestId('milestone-label-2')).toBeNull();
  });

  it('hides Delete on the last remaining row (an empty plan is not savable)', () => {
    mockSaved = [SAVED[0]];
    render(<MilestoneEdit />);
    expect(screen.queryByTestId('milestone-delete-0')).toBeNull();
  });

  it('blocks save while the saved plan is unresolved (undefined), even when not loading', () => {
    // A settled read error leaves data undefined with isLoading false: the editor shows the DEFAULT,
    // so saving now would overwrite a real saved plan the user has. Save must be blocked until the
    // query resolves. Fail-on-revert for the `unloaded = saved === undefined` guard (isLoading is
    // false here, so an isLoading-based guard would wrongly let this save through).
    mockSaved = undefined;
    mockIsLoading = false;
    render(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-save'));
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });

  it('the down arrow swaps a row with its neighbour', () => {
    render(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-down-0')); // Start ↓ past Midway
    expect(labelAt(0)).toBe('Midway');
    expect(labelAt(1)).toBe('Start');
  });

  it('blocks save on an invalid order — toasts, flags the row inline, and does NOT call the writer', () => {
    render(<MilestoneEdit />);
    // Swapping the first two rows leaves Start (300k, 2026) BELOW Midway (200k, 2027): the second
    // row now rises in balance → out of order.
    fireEvent.press(screen.getByTestId('milestone-down-0'));
    expect(screen.getByText(/out of order/i)).toBeTruthy(); // live inline warning
    fireEvent.press(screen.getByTestId('milestone-save'));
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/lower balance and a later date/i));
    expect(mockSaveMilestones).not.toHaveBeenCalled();
  });

  it('a valid save hands the full plan to saveMilestones and navigates back', async () => {
    render(<MilestoneEdit />);
    fireEvent.press(screen.getByTestId('milestone-save'));
    // Flush the in-flight guard's async action.
    await Promise.resolve();
    expect(mockSaveMilestones).toHaveBeenCalledTimes(1);
    const sent = mockSaveMilestones.mock.calls[0][0];
    expect(sent.map((m) => m.label)).toEqual(['Start', 'Midway', 'Payoff']);
    expect(sent.map((m) => m.targetBalance)).toEqual([300000, 200000, 100000]);
    await Promise.resolve();
    expect(mockBack).toHaveBeenCalled();
  });

  // ===== WHIT-377 adversarial gaps (folded in) — cold-cache hydrate race + reorder bounds =====

  describe('cold-cache hydrate race', () => {
    it('while the read is still loading: shows the built-in DEFAULT and blocks save', async () => {
      mockSaved = undefined;      // cold cache — nothing resolved yet
      mockIsLoading = true;
      render(<MilestoneEdit />);

      // The default plan (src/milestones.ts) is shown — NOT a blank form.
      expect(labelAt(0)).toBe('Kickoff');
      expect(labelAt(4)).toBe('Target');

      // Save is blocked: pressing it must NOT hand the default plan to the writer.
      await act(async () => { fireEvent.press(screen.getByTestId('milestone-save')); await Promise.resolve(); });
      expect(mockSaveMilestones).not.toHaveBeenCalled();
    });

    it('when the real saved plan resolves: the seeded latch re-seeds the rows AND unblocks save', async () => {
      mockSaved = undefined;
      mockIsLoading = true;
      const { rerender } = render(<MilestoneEdit />);
      expect(labelAt(0)).toBe('Kickoff'); // default first

      // The read resolves with the user's actual plan.
      mockSaved = SAVED;
      mockIsLoading = false;
      act(() => { rerender(<MilestoneEdit />); });

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
    it('↑ on the first row is disabled', () => {
      render(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-up-0')).toBeDisabled();
    });

    it('↓ on the last row is disabled', () => {
      render(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-down-2')).toBeDisabled();
    });

    it('a mid-list arrow is enabled (the disable is boundary-specific, not blanket)', () => {
      render(<MilestoneEdit />);
      expect(screen.getByTestId('milestone-up-1')).not.toBeDisabled();
    });
  });
});
