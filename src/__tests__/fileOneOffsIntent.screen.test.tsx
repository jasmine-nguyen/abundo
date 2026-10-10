// WHIT-544 — the Transactions screen consumes the "File one-offs" intent set by the File-by-shop
// sheet: when `pendingUncategorizedSelect` is true it lands on the Uncategorized tab in selection
// mode, then CLEARS the flag so a later normal visit is not stuck selecting. The sheet-side button
// is covered in fileByShopSheet ([A28d]); this file covers the screen-side consume.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';

// A STATEFUL flag so the one-shot lifecycle is real: the consume effect calls clearUncategorizedSelect,
// which flips the module flag false, exactly as the real provider would. mockClearSpy asserts it fired.
// (Names are `mock`-prefixed so jest.mock's factory may close over them.)
let mockPendingFlag = false;
const mockClearSpy = jest.fn(() => { mockPendingFlag = false; });
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => ({
  openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: jest.fn(),
  pendingUncategorizedSelect: mockPendingFlag, clearUncategorizedSelect: mockClearSpy,
})));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, WithQueries, settle } from './support/renderWithQueries';
import { colesTxn } from './factory';

const server = installFakeServer();
useTestQueryClient();

const unfiled = (id: string) => colesTxn({ transaction_id: id });

beforeEach(() => {
  resetAuth();
  mockPendingFlag = false;
  mockClearSpy.mockClear();
  server.seed('/categories', [GROCERIES_TOP]);
  server.seed('/transactions/feed', { transactions: [unfiled('t1')], nextCursor: null });
  server.seed('/transactions/uncategorized/feed', { transactions: [unfiled('t1')], nextCursor: null });
  server.seed('/transactions/uncategorized/count', { count: 3 });
  server.seed('/transactions/uncategorized/merchants', { unfiled: 3, groups: [], ungrouped: { count: 3, samples: ['ONE OFF'] } });
});

describe('WHIT-544 Transactions consumes the File-one-offs intent', () => {
  // [I3] one-shot proof across a remount: consuming CLEARS the flag, so a fresh mount of the screen
  // does NOT re-enter selection. Fail-on-revert: remove clearUncategorizedSelect() from the effect →
  // the stateful flag stays true → the remount re-arms selection and "Select" is not found.
  it('[I3] clears the flag so a remount does not re-arm selection', async () => {
    mockPendingFlag = true;
    const first = await renderWithQueries(<Transactions />);
    expect(screen.getByText('Cancel')).toBeTruthy();       // consumed → selection on
    expect(mockClearSpy).toHaveBeenCalledTimes(1);
    first.unmount();

    await renderWithQueries(<Transactions />);             // fresh mount; flag was cleared
    expect(screen.getByText('Select')).toBeTruthy();       // NOT re-armed
    expect(screen.queryByText('0 selected')).toBeNull();
  });

  // [G1] The sheet is an overlay, so Transactions stays mounted while the flag flips true. The effect
  // must react to that CHANGE. Fail-on-revert: gut the effect deps to [] and the mount-time false
  // value means it never re-fires.
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

  // [G2] A query typed before the jump must NOT survive it, or cancelling selection leaves the list
  // silently filtered. Fail-on-revert: remove `setSearch('')` from the effect → after Cancel the box
  // shows 'coles' again.
  it('[G2] resets the search box so a pre-jump query does not linger after Cancel', async () => {
    const { rerender } = await renderWithQueries(<Transactions />);
    fireEvent.changeText(screen.getByLabelText('Search transactions'), 'coles');
    expect(screen.getByLabelText('Search transactions').props.value).toBe('coles'); // sanity: it stuck

    mockPendingFlag = true;                                 // jump armed
    rerender(<WithQueries><Transactions /></WithQueries>);
    expect(screen.getByText('Cancel')).toBeTruthy();         // selection mode → search box hidden

    fireEvent.press(screen.getByText('Cancel'));             // leave selection → search box returns
    expect(screen.getByLabelText('Search transactions').props.value).toBe(''); // NOT 'coles'
    await settle();
  });
});
