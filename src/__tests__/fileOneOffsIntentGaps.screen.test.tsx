// WHIT-544 — ADVERSARIAL GAP tests for the "File one-offs" intent, complementing fileOneOffsIntent
// ([I1]/[I2]/[I3]) and fileByShopSheetGaps ([A28d]/[A28e]). Those cover: mount-with-flag-true,
// mount-with-flag-false, and remount-does-not-re-arm; plus the sheet button. NOT covered and pinned
// here:
//   [G1] the flag flips true while the screen is ALREADY MOUNTED (the REAL production path — the
//        sheet is an overlay; Transactions never unmounts) — proves the effect reacts to the flag
//        CHANGE, not just its mount-time value. [I1]/[I3] both mount with the flag already true, so
//        they pass even if the effect deps are gutted to [] — this test does not.
//   [G2] the jump CLEARS the search box (effect calls setSearch('')) — so a query typed before the
//        jump does not silently re-filter the list when the user later cancels selection.
//   [G3] the landed selection is FUNCTIONAL end-to-end: tick a row → Re-categorize hands exactly that
//        id to the multi-picker and leaves selection mode (regression guard on the existing flow).
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';

// Stateful flag + STABLE spies (module-scope, so identity survives re-renders — a fresh jest.fn per
// render would defeat toHaveBeenCalled assertions and change the effect's dep identity).
let mockPendingFlag = false;
const mockClearSpy = jest.fn(() => { mockPendingFlag = false; });
const mockOpenMultiPicker = jest.fn();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      openMultiPicker: mockOpenMultiPicker, showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn(),
      pendingUncategorizedSelect: mockPendingFlag, clearUncategorizedSelect: mockClearSpy,
    }),
  };
});
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => {
  const ReactLib = require('react');
  return { useFocusEffect: (cb: () => void) => ReactLib.useEffect(() => cb(), [cb]), useRouter: () => ({ push: jest.fn() }) };
});

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, WithQueries, settle } from './support/renderWithQueries';

const server = installFakeServer();
useTestQueryClient();

const CAT = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7FD49B', parent: null };
const unfiled = (id: string) => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01', description: 'COLES',
  merchant_name: 'Coles', amount: -12.5, account_id: 'a1', account_name: 'ANZ', category: null,
  status: 'posted', type: 'PAYMENT', counts_to_budget: true,
});

beforeEach(() => {
  resetAuth();
  mockPendingFlag = false;
  mockClearSpy.mockClear();
  mockOpenMultiPicker.mockClear();
  server.seed('/categories', [CAT]);
  server.seed('/transactions/feed', { transactions: [unfiled('t1')], nextCursor: null });
  server.seed('/transactions/uncategorized/feed', { transactions: [unfiled('t1')], nextCursor: null });
  server.seed('/transactions/uncategorized/count', { count: 3 });
  server.seed('/transactions/uncategorized/merchants', { unfiled: 3, groups: [], ungrouped: { count: 3, samples: ['ONE OFF'] } });
});

describe('WHIT-544 GAP — the intent is consumed on a flag CHANGE, not just at mount', () => {
  // [G1] The screen mounts NORMALLY (flag false, "Select" button, on the All tab). THEN the sheet
  // sets the flag (a re-render with the flag now true) — this is exactly the runtime path, because
  // the File-by-shop sheet is an overlay and Transactions stays mounted underneath it. The effect
  // must react to that change: enter selection mode + clear the flag.
  // GENUINE FAIL-ON-REVERT: gut the effect deps to [] (or drop pendingUncategorizedSelect from them)
  // and this reddens — the mount-time value was false so the effect never re-fires. [I1]/[I3] would
  // STILL pass under that break (they mount with the flag already true), which is why this is a gap.
  it('[G1] enters selection mode when the flag flips true on an already-mounted screen', async () => {
    const { rerender } = await renderWithQueries(<Transactions />);
    expect(screen.getByText('Select')).toBeTruthy();       // normal: not selecting
    expect(screen.queryByText('0 selected')).toBeNull();

    mockPendingFlag = true;                                 // the sheet armed the jump
    rerender(<WithQueries><Transactions /></WithQueries>);  // the overlay-driven re-render

    expect(screen.getByText('Cancel')).toBeTruthy();        // now in selection mode
    expect(screen.getByText('0 selected')).toBeTruthy();     // the action bar is up
    expect(mockClearSpy).toHaveBeenCalledTimes(1);              // consumed and cleared
    await settle();
  });
});

describe('WHIT-544 GAP — the jump clears a stale search query', () => {
  // [G2] A query typed before the jump must NOT survive it: the effect calls setSearch(''), so when
  // the user later cancels selection the list is not silently filtered by a query they can no longer
  // see (the search box is hidden in selection mode).
  // FAIL-ON-REVERT: remove `setSearch('')` from the effect → after Cancel the box shows 'coles' again.
  it('[G2] resets the search box so a pre-jump query does not linger after Cancel', async () => {
    const { rerender } = await renderWithQueries(<Transactions />);
    const searchBox = screen.getByLabelText('Search transactions');
    fireEvent.changeText(searchBox, 'coles');
    expect(screen.getByLabelText('Search transactions').props.value).toBe('coles'); // sanity: it stuck

    mockPendingFlag = true;                                 // jump armed
    rerender(<WithQueries><Transactions /></WithQueries>);
    expect(screen.getByText('Cancel')).toBeTruthy();         // selection mode → search box hidden

    fireEvent.press(screen.getByText('Cancel'));             // leave selection → search box returns
    expect(screen.getByLabelText('Search transactions').props.value).toBe(''); // NOT 'coles'
    await settle();
  });
});

describe('WHIT-544 GAP — the landed selection is functional (regression guard)', () => {
  // [G3] After the jump lands in selection mode, the EXISTING multi-select flow must still work: tick
  // the leftover row → the count updates → Re-categorize hands exactly that id to the multi-picker and
  // exits selection. Guards that the WHIT-544 jump doesn't break the WHIT-291 flow it feeds into.
  // (Behaviour-lock on the existing flow reached via the new entry point, not a fail-on-revert of the
  // WHIT-544 diff itself.)
  it('[G3] a tick + Re-categorize after the jump batches exactly the picked id and exits selection', async () => {
    mockPendingFlag = true;
    await renderWithQueries(<Transactions />);
    expect(screen.getByText('0 selected')).toBeTruthy();

    fireEvent.press(screen.getByRole('checkbox'));           // tick the one leftover row (t1)
    expect(screen.getByText('1 selected')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Re-categorize selected transactions'));
    expect(mockOpenMultiPicker).toHaveBeenCalledWith(['t1']); // exactly the picked id, batched
    expect(screen.getByText('Select')).toBeTruthy();          // selection exited (back to normal header)
    expect(screen.queryByText('1 selected')).toBeNull();
  });
});
