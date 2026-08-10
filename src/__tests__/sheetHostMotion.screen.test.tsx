// WHIT-459 host-mechanics fold — every SheetHost-mechanics screen test that mounts <Overlays />
// over the data-layer-mocked context regime (jest.mock('../context') + the screenQueryMocks
// query mock) lives here, one child describe per concern. Folded in (scenarios preserved 1:1):
//   - WHIT-199  reduce-motion wiring          (was sheetHostMotion.screen.test.tsx — the survivor)
//   - WHIT-290/293 drag-to-dismiss grabber    (was sheetDragDismiss.screen.test.tsx)
//   - WHIT-294  keyboard avoidance            (was sheetKeyboardAvoid.screen.test.tsx)
//   - WHIT-288  scroll-host backdrop          (was sheetScrollHost.screen.test.tsx)
//   - WHIT-285  AddRule object collapse       (was overlaysSheetDraftObjectCollapse.screen.test.tsx)
// The three jest.mock()s are byte-identical across all five sources, so they hoist once at module
// scope; each source keeps its own consts / fns / state builders / beforeEach inside its describe.
// useReduceMotion is mocked module-wide but is inert for the four non-motion sources (the real hook
// also resolves false synchronously in jest, and none of them assert on motion). A module-level
// afterEach restores spies (config clears call-counts but not spyOn installs) so the WHIT-199
// Animated.spring spy can't leak into a later describe.
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Modal, Animated, KeyboardAvoidingView, ScrollView } from 'react-native';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';
import { SHEET_DISMISS_DISTANCE, shouldDismissSheet } from '../motion/sheetMotion';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

// The reduce-motion gate under test (WHIT-199). Controllable so both branches are deterministic (the
// real hook resolves async off a native probe — no good for a branch assertion). Inert for the other
// four describes: the real hook also returns false synchronously in jest, and none of them assert on
// motion, so mocking it to a fixed false changes nothing for them.
let mockReduceMotion = false;
jest.mock('../motion/useReduceMotion', () => ({ useReduceMotion: () => mockReduceMotion }));

import { Overlays } from '../components/Overlays';

// jest.config clearMocks resets call-counts but NOT spyOn installs; restore them so the WHIT-199
// Animated.spring spy can't survive into a later child describe.
afterEach(() => { jest.restoreAllMocks(); });

// ===== WHIT-199 GAP — SheetHost reduce-motion WIRING (Overlays.tsx), the half sheetMotion.screen.test.ts
// can't reach: springSheetIn is unit-tested, but nothing proves SheetHost wires useReduceMotion →
// the Modal's animationType AND kicks the open spring (and re-kicks it on every reopen). Native-
// driver values don't advance in jest, so we assert the BRANCH/WIRING (animationType + that a
// spring was started / suppressed), never motion frames. Fail-on-revert:
//   - revert `animationType={reduceMotion ? 'none' : 'fade'}` to the old 'slide' → both asserts flip
//   - drop the open-effect's springSheetIn call → "spring on open" flips
//   - break the effect's `open` re-fire → the reopen count flips
describe('SheetHost reduce-motion wiring (WHIT-199)', () => {
  function paycycleState(): AppContext {
    return {
      sheet: { mode: 'paycycle' },
      toast: null,
      payCycle: { length: 14, last_pay_date: '2026-06-06' },
      setSheet: jest.fn(),
      setPayCycleLength: jest.fn(),
      setPayday: jest.fn(),
    } as unknown as AppContext;
  }
  function closedState(): AppContext {
    return { ...paycycleState(), sheet: null } as AppContext;
  }

  beforeEach(() => {
    jest.restoreAllMocks();
    mockReduceMotion = false;
  });

  it('motion on: Modal fades (not slides) and the open spring is started, content mounted', () => {
    mockReduceMotion = false;
    const springSpy = jest.spyOn(Animated, 'spring')
      .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
    mockState = paycycleState();
    const { UNSAFE_getByType } = render(<Overlays />);
    expect(UNSAFE_getByType(Modal).props.animationType).toBe('fade'); // NOT the old 'slide'
    expect(screen.getByText('Fortnightly')).toBeTruthy();             // sheet content mounted
    expect(springSpy).toHaveBeenCalledTimes(1);                       // the open spring fired
  });

  it('reduce-motion: Modal does not animate and NO spring is started (instant jump)', () => {
    mockReduceMotion = true;
    const springSpy = jest.spyOn(Animated, 'spring');
    mockState = paycycleState();
    const { UNSAFE_getByType } = render(<Overlays />);
    expect(UNSAFE_getByType(Modal).props.animationType).toBe('none');
    expect(screen.getByText('Fortnightly')).toBeTruthy(); // still rendered immediately
    expect(springSpy).not.toHaveBeenCalled();
  });

  it('toggling reduce-motion while a sheet is OPEN does not re-seed/re-spring it (qa edge #2)', () => {
    // Sheet opens under reduce-motion (instant, no spring). The user then flips reduce-motion OFF
    // while the sheet stays open — the spring is keyed on `open`, not reduceMotion, so an at-rest
    // sheet must NOT suddenly spring under them. Fail-on-revert: put reduceMotion back in the open
    // effect's deps and this rerun springs → the count flips to 1.
    mockReduceMotion = true;
    const springSpy = jest.spyOn(Animated, 'spring')
      .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
    mockState = paycycleState();
    const { rerender } = render(<Overlays />);
    expect(springSpy).not.toHaveBeenCalled();  // opened under reduce-motion → no spring
    mockReduceMotion = false;                   // OS reduce-motion flipped OFF, sheet still open
    rerender(<Overlays />);
    expect(springSpy).not.toHaveBeenCalled();  // at-rest sheet is not re-sprung
  });

  it('reopen still springs — the open effect re-fires on every open (not stuck at rest)', () => {
    mockReduceMotion = false;
    const springSpy = jest.spyOn(Animated, 'spring')
      .mockReturnValue({ start: jest.fn() } as unknown as Animated.CompositeAnimation);
    mockState = closedState();
    const { rerender } = render(<Overlays />);
    expect(springSpy).not.toHaveBeenCalled();   // closed → no spring
    mockState = paycycleState();
    rerender(<Overlays />);
    expect(springSpy).toHaveBeenCalledTimes(1); // first open
    mockState = closedState();
    rerender(<Overlays />);
    mockState = paycycleState();
    rerender(<Overlays />);
    expect(springSpy).toHaveBeenCalledTimes(2); // reopen re-seeds + springs
  });
});

// ===== WHIT-290 — the grabber wires drag-to-dismiss on the shared SheetHost. These drive the raw
// responder handlers with synthetic pageY events (RN's responder system, no gesture library),
// proving a drag PAST the threshold closes the sheet and a SHORT drag does not. The visual
// follow-the-finger + spring-back is device-verified; the close DECISION is proven here.
describe('SheetHost drag-to-dismiss (WHIT-290/WHIT-293)', () => {
  const fns = {
    setSheet: jest.fn(), setPayCycleLength: jest.fn(), setPayday: jest.fn(),
  };
  beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

  // The pay-cycle sheet is the simplest to mount (no category/query plumbing).
  function sheetState(): AppContext {
    return {
      sheet: { mode: 'paycycle' }, toast: null,
      payCycle: { length: 14, last_pay_date: '2026-06-06' }, ...fns,
    } as unknown as AppContext;
  }

  // A slow drag from y=100 down to y=100+distance (timestamps far apart → negligible velocity, so
  // the DISTANCE path decides). Raw responder events, no gesture library.
  function dragGrabber(distance: number) {
    const grabber = screen.getByTestId('sheet-grabber');
    fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 100, timestamp: 0 } });
    fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 100 + distance, timestamp: 400 } });
    fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 100 + distance, timestamp: 400 } });
  }

  // A quick short flick: a small total distance but a fast last segment (18px in 8ms ≈ 2.25 px/ms).
  function flickGrabber() {
    const grabber = screen.getByTestId('sheet-grabber');
    fireEvent(grabber, 'responderGrant', { nativeEvent: { pageY: 100, timestamp: 0 } });
    fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 118, timestamp: 8 } });
    fireEvent(grabber, 'responderMove', { nativeEvent: { pageY: 136, timestamp: 16 } });
    fireEvent(grabber, 'responderRelease', { nativeEvent: { pageY: 138, timestamp: 18 } }); // dy=38 (< distance)
  }

  describe('shouldDismissSheet decision (WHIT-290/WHIT-293)', () => {
    // Pure decision behind the drag; lives in the screen project because sheetMotion imports
    // Animated (the logic project can't load react-native).
    it('dismisses a far-enough pull, springs back under it, ignores upward drags', () => {
      expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE + 1, 0)).toBe(true);
      expect(shouldDismissSheet(SHEET_DISMISS_DISTANCE, 0)).toBe(false);
      expect(shouldDismissSheet(0, 0)).toBe(false);
      expect(shouldDismissSheet(-200, 0)).toBe(false);
    });

    it('dismisses a quick downward flick even when the pull is short (WHIT-293)', () => {
      expect(shouldDismissSheet(24, 1.0)).toBe(true);   // short but fast → dismiss
      expect(shouldDismissSheet(24, 0.1)).toBe(false);  // short and slow → spring back
      expect(shouldDismissSheet(-24, 2.0)).toBe(false); // fast but UPWARD → never dismiss
    });
  });

  describe('grabber pull-down-to-dismiss (WHIT-290/WHIT-293)', () => {
    it('a drag past the threshold closes the sheet', () => {
      mockState = sheetState();
      render(<Overlays />);
      dragGrabber(SHEET_DISMISS_DISTANCE + 40);
      expect(fns.setSheet).toHaveBeenCalledWith(null);
    });

    it('a short, slow drag springs back and does NOT close', () => {
      mockState = sheetState();
      render(<Overlays />);
      dragGrabber(20);
      expect(fns.setSheet).not.toHaveBeenCalled();
    });

    it('a quick short flick closes the sheet (WHIT-293)', () => {
      mockState = sheetState();
      render(<Overlays />);
      flickGrabber();
      expect(fns.setSheet).toHaveBeenCalledWith(null);
    });
  });
});

// ===== WHIT-294 — the pop-up SheetHost wraps its sheet in a KeyboardAvoidingView so a focused field's
// form (incl. its submit button) lifts above the keyboard instead of being hidden under it. The
// actual keyboard lift is device-only; this locks the structure (the sheet is inside a
// KeyboardAvoidingView with a real behavior) and that the sheet still renders + closes.
describe('SheetHost keyboard avoidance (WHIT-294)', () => {
  const fns = { setSheet: jest.fn(), setPayCycleLength: jest.fn(), setPayday: jest.fn() };
  beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

  function sheetState(): AppContext {
    return {
      sheet: { mode: 'paycycle' }, toast: null,
      payCycle: { length: 14, last_pay_date: '2026-06-06' }, ...fns,
    } as unknown as AppContext;
  }

  describe('SheetHost lifts the sheet above the keyboard (WHIT-294)', () => {
    it('wraps the sheet in a KeyboardAvoidingView with a real behavior', () => {
      mockState = sheetState();
      const { UNSAFE_getByType } = render(<Overlays />);
      const kav = UNSAFE_getByType(KeyboardAvoidingView);
      expect(kav).toBeTruthy();
      expect(['padding', 'height', 'position']).toContain(kav.props.behavior); // set, not undefined
    });

    it('still renders the sheet content and closes on the backdrop', () => {
      mockState = sheetState();
      render(<Overlays />);
      expect(screen.getByText('Fortnightly')).toBeTruthy(); // sheet content mounted
      fireEvent.press(screen.getByLabelText('Close'));
      expect(fns.setSheet).toHaveBeenCalledWith(null);
    });
  });
});

// ===== WHIT-288 — the pop-up SheetHost no longer wraps its scrolling content in a Pressable.
// The old backdrop-as-wrapper (a Pressable AROUND the sheet + its ScrollView, there only to
// swallow taps so they didn't close the sheet) competed with the ScrollView for the touch, so
// the category picker scrolled only intermittently. The backdrop now sits BEHIND the sheet as
// a labelled sibling. The scroll gesture itself is device-specific and can't be exercised
// headlessly, so these lock the tap-to-close behaviour of the new structure (a distinct "Close"
// backdrop closes; taps on the list select a row and never leak to a close) — the "Close"
// backdrop is what the old wrapping structure lacked, so its absence is the fail-on-revert.
describe('SheetHost scroll-host backdrop (WHIT-288)', () => {
  const CAT_A = { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 };
  const CAT_B = { id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e0af68', bucket: 'Lifestyle', recent: 0 };

  const fns = {
    chooseCategory: jest.fn(), createCategoryInline: jest.fn(), setSheet: jest.fn(),
    readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
  };
  beforeEach(() => { Object.values(fns).forEach((f) => f.mockClear()); });

  function pickerState(): AppContext {
    return {
      sheet: { mode: 'picker', txId: 't1' },
      transactions: [{ transaction_id: 't1', amount: -12.5, description: 'COLES', merchant_name: 'Coles' }],
      categories: [CAT_A, CAT_B], toast: null, ...fns,
    } as unknown as AppContext;
  }

  describe('SheetHost tap-to-close via a backdrop behind the sheet (WHIT-288)', () => {
    it('a distinct labelled backdrop closes the sheet on tap', () => {
      // The old sheet had no such control — the whole card was the close-wrapper. Its presence is
      // the fail-on-revert: revert to the wrapping Pressable and this "Close" button disappears.
      mockState = pickerState();
      render(<Overlays />);
      fireEvent.press(screen.getByLabelText('Close'));
      expect(fns.setSheet).toHaveBeenCalledWith(null);
    });

    it('the tap-to-close backdrop does NOT wrap the scrolling list', () => {
      // The bug was the closing element wrapping the ScrollView. Lock the fix structurally: the
      // "Close" backdrop must have NO ScrollView in its subtree — it's a sibling behind the sheet,
      // not an ancestor of the list. Re-wrapping the list in a labelled Pressable (reintroducing
      // the exact bug) would put a ScrollView under this element and trip the assertion. (ScrollView
      // matches by type reference in this RN/RNTL; Pressable does not, so we anchor on the list.)
      mockState = pickerState();
      const { UNSAFE_getByType } = render(<Overlays />);
      expect(UNSAFE_getByType(ScrollView)).toBeTruthy(); // the picker list exists...
      const close = screen.getByLabelText('Close');
      expect(close.findAll((n) => n.type === ScrollView)).toHaveLength(0); // ...but not under the backdrop
    });

    it('tapping a category row selects it (list stays interactive)', () => {
      mockState = pickerState();
      render(<Overlays />);
      fireEvent.press(screen.getByText('Groceries'));
      expect(fns.chooseCategory).toHaveBeenCalledWith('groceries');
    });

    it('still renders the picker list', () => {
      mockState = pickerState();
      render(<Overlays />);
      expect(screen.getByText('Groceries')).toBeTruthy();
      expect(screen.getByText('Coffee')).toBeTruthy();
    });
  });
});

// ===== WHIT-285 — gaps for the two-field OBJECT collapse + guarded alias setters the refactor
// introduced in AddRuleSheet (mirrored in GoalBalanceSheet). The lock-survival suites
// (overlaysSheetDraft*.screen.test.tsx) pin that BOTH fields survive a lock [A5][A6]; they do
// NOT pin the seam the collapse created: that an alias setter MERGES rather than clobbers its
// sibling field, and that the guarded bailout makes a no-op setter a REAL no-op — no state
// churn, no extra persist write. We mount AddRuleSheet over a Map-backed draft store (the
// AddRuleSheet.screen.test.tsx mock pattern) so we can read the RAW persisted draft object and
// COUNT writes — neither is observable through the full-provider lock harness.
describe('AddRule two-field object collapse (WHIT-285)', () => {
  const RULE_INPUT = 'e.g. NETFLIX';
  const DRAFT_KEY = 'addrule:new'; // no ruleId → the new-rule key

  // A real Map behind spies, so we can both read the persisted draft and count writes.
  const store = new Map<string, unknown>();
  const readSheetDraft = jest.fn((key: string): unknown => store.get(key));
  const writeSheetDraft = jest.fn((key: string, value: unknown) => { store.set(key, value); });

  const fns = {
    updateRule: jest.fn(), saveManualRule: jest.fn(), setSheet: jest.fn(),
    readSheetDraft, writeSheetDraft,
  };

  function newRuleState(): AppContext {
    return {
      sheet: { mode: 'addrule' }, // no ruleId → key `addrule:new`, no editing prefill
      toast: null,
      rules: [],
      categories: [
        { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
        { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
      ],
      ...fns,
    } as unknown as AppContext;
  }

  beforeEach(() => {
    store.clear();
    readSheetDraft.mockClear();
    writeSheetDraft.mockClear();
    mockState = newRuleState();
  });

  describe('WHIT-285 — AddRule two-field object collapse + guarded alias setters', () => {
    // [B1] The object-merge: changing categoryId must keep the sibling `pattern` in the SAME draft.
    // A non-merge setter (setDraft({ categoryId: value })) would drop `pattern` from the persisted
    // object — this pins {...prev, categoryId: value}.
    it('[B1] selecting a category after typing a pattern persists BOTH fields (merge, no clobber)', () => {
      render(<Overlays />);
      fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
      fireEvent.press(screen.getByText('Groceries'));

      expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'SPOTIFY', categoryId: 'groceries' });
      // the live field still reflects it — the collapse didn't decouple state from the input
      expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY');
    });

    // [B2] The reverse merge: typing a pattern AFTER selecting a category must not clobber the
    // categoryId. Order-independence of the object-merge.
    it('[B2] typing a pattern after selecting a category keeps the categoryId (merge both ways)', () => {
      render(<Overlays />);
      fireEvent.press(screen.getByText('Subscriptions'));
      fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'NETFLIX');

      expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'NETFLIX', categoryId: 'subs' });
    });

    // [B3] The guarded bailout: re-tapping the ALREADY-selected pill returns `prev` unchanged, so
    // React bails the update and the persist effect never re-fires. Dropping the
    // `prev.categoryId === value` guard would re-render with a new (equal) object and write again.
    it('[B3] re-tapping the already-selected category is a no-op — no extra write, pattern untouched', () => {
      render(<Overlays />);
      fireEvent.changeText(screen.getByPlaceholderText(RULE_INPUT), 'SPOTIFY');
      fireEvent.press(screen.getByText('Groceries')); // first selection → a real write

      const writesBefore = writeSheetDraft.mock.calls.length;
      const draftBefore = store.get(DRAFT_KEY);

      fireEvent.press(screen.getByText('Groceries')); // re-tap the SAME pill

      expect(writeSheetDraft.mock.calls.length).toBe(writesBefore); // no rewrite
      expect(store.get(DRAFT_KEY)).toBe(draftBefore);               // same reference, not a fresh equal object
      expect(store.get(DRAFT_KEY)).toEqual({ pattern: 'SPOTIFY', categoryId: 'groceries' });
      expect(screen.getByPlaceholderText(RULE_INPUT).props.value).toBe('SPOTIFY'); // sibling field intact
    });
  });
});
