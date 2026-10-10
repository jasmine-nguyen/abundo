// Screen test: the AddRuleSheet multi-condition builder (WHIT-563). Builds ≥2 condition rows with
// per-field operators, a dollar amount, an account picker, a spending/income choice and an AND/OR
// toggle; saves the conditions+logic payload; edits round-trip; single-condition classic rules keep
// today's behaviour (covered in AddRuleSheet.screen.test.tsx, plus the backward-compat case here).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

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

// Rules and recent charges come from the server; everything else is the sheet's own state.
async function mount({ rules = [], transactions = [], ...over }: Partial<Record<string, unknown>> = {}) {
  server.seed('/categories', CATS);
  server.seed('/rules', rules);
  server.seed('/transactions', transactions);
  const state = { sheet: { mode: 'addrule' }, toast: null, ...fns, ...over } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
  resetAuth();
});

it('builds a two-condition rule and saves it directly (no preview step)', async () => {
  await mount();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'NETFLIX' },
      { field: 'amount', operator: 'less_than', value: '30' },
    ],
    logic: 'all',
  }, false);
  // A multi rule never routes through the single-rule preview/confirm sheet.
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

it('the logic toggle sets "any" in the saved payload', async () => {
  await mount();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByTestId('rule-logic-any'));
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('NETFLIX', 'subs', false, expect.objectContaining({ logic: 'any' }), false);
});

it.each([
  {
    name: 'a single direction condition saves via the conditions payload, not the classic preview',
    transactions: [], field: 'direction', pick: null, category: 'Subscriptions',
    value: 'debit', categoryId: 'subs', condition: { field: 'direction', operator: 'is', value: 'debit' }, // defaults to Spending (debit)
  },
  {
    name: 'an account condition stores the picked account id',
    transactions: [{ transaction_id: 't1', account_id: 'acc-1', account_name: 'Everyday' }],
    field: 'account', pick: 'rule-account-0-acc-1', category: 'Groceries',
    value: 'acc-1', categoryId: 'groceries', condition: { field: 'account', operator: 'equals', value: 'acc-1' },
  },
])('a single non-text condition saves via the conditions payload: $name', async ({ transactions, field, pick, category, value, categoryId, condition }) => {
  await mount({ transactions });
  fireEvent.press(screen.getByTestId(`rule-field-0-${field}`));
  if (pick) fireEvent.press(screen.getByTestId(pick));
  fireEvent.press(screen.getByText(category));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith(value, categoryId, false, { conditions: [condition], logic: 'all' }, false);
  expect(fns.setSheet).not.toHaveBeenCalled();
});

it('an amount condition of 0 keeps save disabled', async () => {
  await mount();
  fireEvent.press(screen.getByTestId('rule-field-0-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-0'), '0');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('a too-short description-contains value keeps save disabled (mirrors the server floor)', async () => {
  await mount();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'AB'); // < 4 alphanumerics
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(fns.setSheet).not.toHaveBeenCalled();
});

it('editing a multi-condition rule round-trips its conditions and logic', async () => {
  await mount({
    sheet: { mode: 'addrule', ruleId: 'm1' },
    rules: [{
      id: 'm1', value: 'COLES', categoryId: 'groceries',
      field: 'description', operator: 'contains',
      conditions: [
        { field: 'description', operator: 'contains', value: 'COLES' },
        { field: 'amount', operator: 'greater_than', value: '100' },
      ],
      logic: 'any',
    }],
  });
  expect(screen.getByTestId('rule-condition-0')).toBeTruthy();
  expect(screen.getByTestId('rule-condition-1')).toBeTruthy();
  expect(screen.getByDisplayValue('COLES')).toBeTruthy();
  expect(screen.getByDisplayValue('100')).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('m1', 'COLES', 'groceries', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'COLES' },
      { field: 'amount', operator: 'greater_than', value: '100' },
    ],
    logic: 'any',
  }, false);
});

// [G1] Switch a row's field after typing: the old text must not leak into the new field, and the
// operator must snap to the new field's default (not keep the previous field's picked operator).
it('switching a row field clears the stale value and resets the operator to the field default', async () => {
  await mount();
  fireEvent.press(screen.getByTestId('rule-op-0-equals'));
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy();
  fireEvent.press(screen.getByTestId('rule-field-0-amount'));
  expect(screen.queryByDisplayValue('NETFLIX')).toBeNull();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), '30');
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('30', 'groceries', false, {
    conditions: [{ field: 'amount', operator: 'less_than', value: '30' }],
    logic: 'all',
  }, false);
});

// [G3] Editing an account rule whose account_id isn't in the recent-transactions set: the picker must
// still surface that id as a selected pill so the value is visible and editable, and round-trip on save.
it('an editing rule account not in the recent set is surfaced and round-trips', async () => {
  await mount({
    sheet: { mode: 'addrule', ruleId: 'a1' },
    transactions: [],
    rules: [{
      id: 'a1', value: 'acc-gone', categoryId: 'groceries',
      field: 'account', operator: 'equals',
      conditions: [{ field: 'account', operator: 'equals', value: 'acc-gone' }],
      logic: 'all',
    }],
  });
  expect(screen.getByTestId('rule-account-0-acc-gone')).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('a1', 'acc-gone', 'groceries', false, {
    conditions: [{ field: 'account', operator: 'equals', value: 'acc-gone' }],
    logic: 'all',
  }, false);
});

// [G4] Add a second row then remove it: the draft is back to a single description/contains row, so a
// NEW rule must route through the classic WHIT-538 preview (setSheet addRuleConfirm), NOT the direct
// multi conditions payload.
it('adding then removing a row back to one classic row routes a new rule through the preview', async () => {
  await mount();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIX');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '30');
  fireEvent.press(screen.getByTestId('rule-remove-1'));
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'addRuleConfirm', pattern: 'NETFLIX', categoryId: 'subs' }),
  );
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

// [G5] Editing a server-authored rule on a field the builder never offers (merchant / category): the
// field must survive the round-trip (not silently reset to description) and save via the conditions
// payload without corruption.
it.each([
  ['a merchant flat rule preserves the merchant field', { id: 'x1', value: 'GROCERYLAND', categoryId: 'groceries', field: 'merchant', operator: 'contains' }],
  ['a category equals flat rule preserves the category field', { id: 'c1', value: 'GROCERIES', categoryId: 'groceries', field: 'category', operator: 'equals' }],
])('editing %s on save', async (_name, rule) => {
  await mount({ sheet: { mode: 'addrule', ruleId: rule.id }, rules: [rule] });
  expect(screen.getByDisplayValue(rule.value)).toBeTruthy();
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith(rule.id, rule.value, 'groceries', false, {
    conditions: [{ field: rule.field, operator: rule.operator, value: rule.value }],
    logic: 'all',
  }, false);
});

// [G7] Reducing a MULTI rule down to one classic description/contains row on EDIT must save via the
// flat path (updateRule with 4 args, no conditions payload) — the collapse-to-single case that mirrors
// context.tsx nulling conditions/logic on the classic edit path.
it('editing a multi rule down to one classic row saves via the flat path (no conditions payload)', async () => {
  await mount({
    sheet: { mode: 'addrule', ruleId: 'm2' },
    rules: [{
      id: 'm2', value: 'NETFLIX', categoryId: 'subs',
      field: 'description', operator: 'contains',
      conditions: [
        { field: 'description', operator: 'contains', value: 'NETFLIX' },
        { field: 'amount', operator: 'less_than', value: '30' },
      ],
      logic: 'all',
    }],
  });
  fireEvent.press(screen.getByTestId('rule-remove-1')); // drop the amount row → one description/contains row
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('m2', 'NETFLIX', 'subs', false, undefined, false);
});

// --- WHIT-562 overlap warning ----------------------------------------------------
// When a multi rule can co-match a charge with an existing rule that files elsewhere, the builder
// SOFT-warns before saving (it does not block): Save anyway or Cancel.

const colesGroceries = { id: 'g1', value: 'COLES', categoryId: 'groceries' };
const wooliesGroceries = { id: 'w1', value: 'WOOLIES', categoryId: 'groceries' };

// Build a two-condition rule "COLES AND under $40", filed as Subscriptions.
function buildColesUnder40() {
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'COLES');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '40');
  fireEvent.press(screen.getByText('Subscriptions'));
}

it('warns (does not save) when a multi rule overlaps an existing rule filing elsewhere', async () => {
  await mount({ rules: [colesGroceries] });
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.getByTestId('rule-overlap')).toBeTruthy();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('"Save anyway" saves the rule despite the overlap', async () => {
  await mount({ rules: [colesGroceries] });
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
  await mount({ rules: [colesGroceries] });
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  fireEvent.press(screen.getByTestId('rule-overlap-cancel'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('a non-overlapping multi rule saves directly (no warning)', async () => {
  // Existing rule matches WOOLIES; the candidate needs COLES too, so no charge matches both.
  await mount({ rules: [wooliesGroceries] });
  buildColesUnder40();
  fireEvent.press(screen.getByText('Add rule'));
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).toHaveBeenCalledWith('COLES', 'subs', false, expect.objectContaining({ logic: 'all' }), false);
});

// WHIT-670 [A1] An account known only from the balances read (no recent charge on it) is still offered.
it('[A1] offers an account that only the /accounts/balances read knows, named from its id, and saves its id', async () => {
  server.seed('/accounts/balances', [{
    account_id: 'home-loan', amount: 100, available_balance: null, currency: 'AUD', as_of: '2024-01-01T00:00:00Z', account_type: null,
  }]);
  await mount();
  fireEvent.press(screen.getByTestId('rule-field-0-account'));
  fireEvent.press(screen.getByTestId('rule-account-0-home-loan'));
  fireEvent.press(screen.getByText('Groceries'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('home-loan', 'groceries', false, {
    conditions: [{ field: 'account', operator: 'equals', value: 'home-loan' }],
    logic: 'all',
  }, false);
});
