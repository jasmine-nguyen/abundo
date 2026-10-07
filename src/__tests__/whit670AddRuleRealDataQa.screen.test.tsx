// WHIT-670 QA — the add-rule pop-up over the fake server: the paths the hand-written query mocks
// could never reach. The account options come from the real balances read, the category list is
// the real selectCategories output (sorted by the sheet), and a malformed /categories payload goes
// through the real "fail loudly" select into the sheet's error gate.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD, SUBSCRIPTIONS_RECORD } from './support/categories';
import { useTestQueryClient, settle } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(),
  readSheetDraft: jest.fn((): unknown => undefined),
  writeSheetDraft: jest.fn(),
};

const CATS = [
  SUBSCRIPTIONS_RECORD,
  GROCERIES_RECORD,
];

const balance = (accountId: string) => ({
  account_id: accountId, amount: 100, available_balance: null, currency: 'AUD', as_of: '2024-01-01T00:00:00Z', account_type: null,
});

async function open(sheet: Record<string, unknown> = { mode: 'addrule' }) {
  const state = { sheet, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

const lastDraftCategoryId = () => {
  const calls = fns.writeSheetDraft.mock.calls;
  return (calls[calls.length - 1][1] as { categoryId: string | null }).categoryId;
};

beforeEach(() => {
  jest.clearAllMocks();
  fns.readSheetDraft.mockImplementation(() => undefined);
  resetAuth();
  server.seed('/categories', CATS);
});

// [A1] An account known only from the balances read (no recent charge on it) is still offered.
it('[A1] offers an account that only the /accounts/balances read knows, named from its id, and saves its id', async () => {
  server.seed('/accounts/balances', [balance('home-loan')]);
  await open();
  fireEvent.press(screen.getByTestId('rule-field-0-account'));
  expect(screen.getByTestId('rule-account-0-home-loan')).toBeTruthy();
  expect(screen.getByText('Home Loan')).toBeTruthy();
  fireEvent.press(screen.getByTestId('rule-account-0-home-loan'));
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('home-loan', 'groceries', false, {
    conditions: [{ field: 'account', operator: 'equals', value: 'home-loan' }],
    logic: 'all',
  }, false);
});

// [A2] An account seen on a recent charge is named from that charge's account_name, and the
// balances read for the same account doesn't add a second pill.
it('[A2] names an account from its recent charges and lists it once when balances know it too', async () => {
  server.seed('/transactions', [
    { transaction_id: 't1', account_id: 'acc-1', account_name: 'Everyday', description: 'COLES', amount: -10, date: '2024-01-02' },
  ]);
  server.seed('/accounts/balances', [balance('acc-1')]);
  await open();
  fireEvent.press(screen.getByTestId('rule-field-0-account'));
  expect(screen.getByText('Everyday')).toBeTruthy();
  expect(screen.queryByText('Acc 1')).toBeNull();
  expect(screen.getAllByTestId('rule-account-0-acc-1')).toHaveLength(1);
});

// [A3] The category pills are the server's list, sorted by name whatever order the server sends.
it('[A3] lists the server categories alphabetically regardless of the order the server sends them', async () => {
  server.seed('/categories', [
    { id: 'z', name: 'Zoo', icon: 'film', bucket: 'Lifestyle' },
    { id: 'a', name: 'Apples', icon: 'cart', bucket: 'Living' },
    { id: 'm', name: 'Movies', icon: 'film', bucket: 'Lifestyle' },
  ]);
  await open();
  const seeded = ['Zoo', 'Apples', 'Movies'];
  const order = screen.UNSAFE_root
    .findAll((node) => typeof node.type === 'string' && seeded.includes(node.props.children))
    .map((node) => node.props.children);
  expect(order).toEqual(['Apples', 'Movies', 'Zoo']);
});

// [A4] A malformed /categories payload (a wrapped object, not an array) makes the real select
// throw → the sheet sees an error, not "loaded and empty" → a valid restored category is kept.
it('[A4] a malformed /categories payload is an error, so a restored category is not dropped from the draft', async () => {
  server.seed('/categories', { categories: CATS });
  fns.readSheetDraft.mockImplementation(() => ({ pattern: 'NETFLIX', categoryId: 'subs' }));
  await open();
  await settle();
  expect(screen.queryByText('Subscriptions')).toBeNull(); // the list never loaded
  expect(lastDraftCategoryId()).toBe('subs');
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(fns.setSheet).not.toHaveBeenCalled();
});

// [A5] Editing: the sheet finds the rule by id in the server's list and prefills from the wire
// `value` field (toRule maps value → pattern), with a server-only extra field ignored.
it('[A5] editing prefills from the server rule `value` and ignores unknown extra fields', async () => {
  server.seed('/rules', [
    { id: 'other', value: 'SPOTIFY', categoryId: 'subs' },
    { id: 'e1', value: 'WOOLWORTHS', categoryId: 'groceries', createdAt: '2024-01-01', hits: 3 },
  ]);
  await open({ mode: 'addrule', ruleId: 'e1' });
  expect(screen.getByText('Edit rule')).toBeTruthy();
  expect(screen.getByDisplayValue('WOOLWORTHS')).toBeTruthy();
  expect(screen.queryByDisplayValue('SPOTIFY')).toBeNull();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'WOOLWORTHS', 'groceries', false, undefined, false);
});

// [A6] A category with a parent from the server is still a pickable pill (the add-rule list is
// flat — children are real categories a rule can file to).
it('[A6] a child category from the server can be picked and is saved by its own id', async () => {
  server.seed('/categories', [
    ...CATS,
    { id: 'takeaway', name: 'Takeaway', icon: 'coffee', bucket: 'Living', parent: 'groceries' },
  ]);
  await open();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'MENULOG');
  fireEvent.press(screen.getByText('Takeaway'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith({ mode: 'addRuleConfirm', pattern: 'MENULOG', categoryId: 'takeaway', budgetExcluded: false });
});
