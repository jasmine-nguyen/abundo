// WHIT-508 — the "Apply my rules" button on the Uncategorized tab.
//
// It is gated on the WHOLE-history count (the number the badge shows), not the loaded-page count:
// after a capped run the loaded page can be empty while hundreds of unfiled charges remain deeper
// in history — exactly when the button is still needed.
// The screen and its data code are real, over the pretend server (WHIT-686).
import { it, expect, jest, beforeEach, describe } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';

const mockSetSheet = jest.fn();
jest.mock('../context', () => require('./support/contextMock').realContextWith(
  () => ({ openMultiPicker: jest.fn(), showToast: jest.fn(), openPicker: jest.fn(), setSheet: mockSetSheet }),
));
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import Transactions from '../../app/(tabs)/transactions';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP } from './support/categories';
import { useTestQueryClient, renderWithQueries, settle } from './support/renderWithQueries';
import { colesTxn } from './factory';

const server = installFakeServer();
useTestQueryClient();

const UNCATEGORIZED_FEED = '/transactions/uncategorized/feed';
const COUNT = '/transactions/uncategorized/count';
const unfiled = (id: string) => colesTxn({ transaction_id: id });

const BUTTON = 'transactions-apply-rules';

const seedUncategorizedFeed = (transactions: unknown[], nextCursor: string | null = null) =>
  server.seed(UNCATEGORIZED_FEED, { transactions, nextCursor });

/** Render, wait for the first reads, and switch to the Uncategorized tab. */
async function renderTab() {
  await renderWithQueries(<Transactions />);
  fireEvent.press(screen.getByTestId('tab-uncategorized'));
  await settle();
}

beforeEach(() => {
  resetAuth();
  mockSetSheet.mockClear();
  server.seed('/categories', [GROCERIES_TOP]);
  server.seed(COUNT, { count: 5 });
  seedUncategorizedFeed([unfiled('t1')]);
});

describe('the "Apply my rules" button', () => {
  it('opens the apply-rules sheet when pressed', async () => {
    await renderTab();
    fireEvent.press(screen.getByTestId(BUTTON));
    expect(mockSetSheet).toHaveBeenCalledWith({ mode: 'applyRules' });
  });

  // The whole-history gate: the loaded page is empty (the rows sit deeper in history), but the
  // badge says 339 remain — which is exactly the state a capped run leaves behind. Fail-on-revert:
  // gate on the local loaded-page count instead and the button vanishes mid-way through the job.
  it('stays visible when the loaded page is empty but history still has unfiled charges', async () => {
    server.seed(COUNT, { count: 339 });
    seedUncategorizedFeed([], 'c1');
    await renderTab();
    expect(screen.getByTestId(BUTTON)).toBeTruthy();
  });
});
