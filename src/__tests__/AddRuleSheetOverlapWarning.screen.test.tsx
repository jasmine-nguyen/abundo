// Screen test: the WHIT-562 multi-condition overlap warning in the rule builder. When a multi rule
// can co-match a charge with an existing rule that files elsewhere, the builder SOFT-warns before
// saving (it does not block) — the user can Save anyway or Cancel. A non-overlapping multi rule
// saves directly, unchanged.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { C } from '../theme';
import type { AppContext } from '../context';
import { styleOf } from './support/layout';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_RECORD, SUBSCRIPTIONS_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(),
  readSheetDraft: () => undefined,
  writeSheetDraft: () => {},
};

const CATS = [
  SUBSCRIPTIONS_RECORD,
  GROCERIES_RECORD,
];

const colesGroceries = { id: 'g1', value: 'COLES', categoryId: 'groceries' };
const wooliesGroceries = { id: 'w1', value: 'WOOLIES', categoryId: 'groceries' };

async function openNew(rules: unknown[]) {
  server.seed('/categories', CATS);
  server.seed('/rules', rules);
  const state = { sheet: { mode: 'addrule' }, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

// Build a two-condition rule "COLES AND under $40", filed as Subscriptions.
function buildColesUnder40() {
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'COLES');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '40');
  fireEvent.press(screen.getByText('Subscriptions'));
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
  resetAuth();
});

it('warns (does not save) when a multi rule overlaps an existing rule filing elsewhere', async () => {
  await openNew([colesGroceries]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-overlap')).toBeTruthy();
  expect(screen.getByText(/files as Groceries/)).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('"Save anyway" is the filled button and "Cancel" the outlined one', async () => {
  await openNew([colesGroceries]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  const save = styleOf(screen.getByTestId('rule-overlap-save'));
  const cancel = styleOf(screen.getByTestId('rule-overlap-cancel'));
  expect(save.backgroundColor).toBe(C.accent);
  expect(cancel.backgroundColor).toBe('transparent');
});

it('"Save anyway" saves the rule despite the overlap', async () => {
  await openNew([colesGroceries]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-overlap-save'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'subs', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'COLES' },
      { field: 'amount', operator: 'less_than', value: '40' },
    ],
    logic: 'all',
  }, false);
});

it('"Cancel" dismisses the warning and does not save', async () => {
  await openNew([colesGroceries]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-overlap-cancel'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('a non-overlapping multi rule saves directly (no warning)', async () => {
  // Existing rule matches WOOLIES; the candidate needs COLES too, so no charge matches both.
  await openNew([wooliesGroceries]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'subs', false, expect.objectContaining({ logic: 'all' }), false);
});

it('does not warn when the overlapping rule files to the SAME category', async () => {
  await openNew([{ id: 's1', value: 'COLES', categoryId: 'subs' }]);
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).toHaveBeenCalled();
});
