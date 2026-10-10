// WHIT-559: the client "Spread this bill" toggle, and WHIT-558's "keep out of budget" toggle beside
// it. A NEW classic spread rule saves DIRECT (skipping the preview/confirm sheet), a non-spread
// classic rule still previews, both flags thread through every writer (classic, multi-condition,
// edit, Replace), and spread + budgetExcluded are mutually exclusive in the UI.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { SUBSCRIPTIONS_RECORD } from './support/categories';
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
  { id: 'bills', name: 'Bills', icon: 'bolt', bucket: 'Living' },
];

async function open(sheet: Record<string, unknown>, rules: unknown[]) {
  server.seed('/categories', CATS);
  server.seed('/rules', rules);
  const state = { sheet, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

const openNew = (rules: unknown[] = []) => open({ mode: 'addrule' }, rules);

const openEdit = (over: Record<string, unknown>) =>
  open({ mode: 'addrule', ruleId: 'e1' }, [{ id: 'e1', value: 'ORIGIN ENERGY', categoryId: 'subs', ...over }]);

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

it('a NEW classic spread rule saves directly and skips the preview sheet', async () => {
  await openNew();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('ORIGIN ENERGY', 'subs', false, undefined, true);
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

it('a NEW classic NON-spread rule still routes through the preview sheet', async () => {
  await openNew();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('editing a spread rule prefills it and rides spread:true through a text-only edit', async () => {
  await openEdit({ spread: true });
  fireEvent.changeText(screen.getByDisplayValue('ORIGIN ENERGY'), 'ORIGIN ENERGY BILL');
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY BILL', 'subs', false, undefined, true);
});

it.each([
  ['turning spread ON clears an inherited budgetExcluded', { budgetExcluded: true }, 'rule-spread', false, true],
  ['turning budgetExcluded ON clears an inherited spread', { spread: true }, 'rule-budget-excluded', true, false],
])('%s (mutually exclusive)', async (_name, inherited, toggle, budgetExcluded, spread) => {
  await openEdit(inherited);
  fireEvent.press(screen.getByTestId(toggle));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', budgetExcluded, undefined, spread);
});

// WHIT-558: the prefilled exclusion must ride through an edit of ONLY the pattern (the shared draft
// object must not drop it when a sibling field changes).
it('editing only the pattern preserves the prefilled budgetExcluded:true', async () => {
  await openEdit({ budgetExcluded: true });
  fireEvent.changeText(screen.getByDisplayValue('ORIGIN ENERGY'), 'ORIGIN ENERGY BILL');
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY BILL', 'subs', true, undefined, false);
});

// The toggle is genuinely two-way, not write-once.
it('turning an inherited exclusion OFF submits budgetExcluded:false', async () => {
  await openEdit({ budgetExcluded: true });
  fireEvent.press(screen.getByTestId('rule-budget-excluded')); // true -> false
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', false, undefined, false);
});

// [A-M1] A NEW multi-condition spread rule saves DIRECT and passes spread as the 5th arg alongside
// the conditions payload; writeMulti() is a separate writer from the classic one.
it('[A-M1] a NEW multi-condition spread rule threads spread:true into saveManualRule', async () => {
  await openNew();
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByTestId('rule-add-condition'));
  fireEvent.press(screen.getByTestId('rule-field-1-amount'));
  fireEvent.changeText(screen.getByTestId('rule-value-1'), '200');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('ORIGIN ENERGY', 'subs', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'ORIGIN ENERGY' },
      { field: 'amount', operator: 'less_than', value: '200' },
    ],
    logic: 'all',
  }, true);
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

// [A-M2] Editing a MULTI-condition rule that already spreads rides spread:true through updateRule's
// 6th arg (the write payload occupies the 5th).
it('[A-M2] editing a multi-condition spread rule threads spread:true into updateRule', async () => {
  await open({ mode: 'addrule', ruleId: 'm1' }, [{
    id: 'm1', value: 'ORIGIN', categoryId: 'bills',
    field: 'description', operator: 'contains', spread: true,
    conditions: [
      { field: 'description', operator: 'contains', value: 'ORIGIN' },
      { field: 'amount', operator: 'greater_than', value: '100' },
    ],
    logic: 'all',
  }]);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('m1', 'ORIGIN', 'bills', false, {
    conditions: [
      { field: 'description', operator: 'contains', value: 'ORIGIN' },
      { field: 'amount', operator: 'greater_than', value: '100' },
    ],
    logic: 'all',
  }, true);
});

// [A-R1] The replace() path: a NEW classic spread rule whose pattern clashes with an existing rule
// in a DIFFERENT category surfaces the "Replace" prompt; tapping Replace retargets the existing rule
// via updateRule — which must carry spread:true.
it('[A-R1] Replace on a NEW classic spread rule retargets the clash with spread:true', async () => {
  await openNew([{ id: 'clash', value: 'ORIGIN ENERGY', categoryId: 'bills', field: 'description', operator: 'contains' }]);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Add rule')); // clash → Replace prompt, no save yet
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('clash', 'ORIGIN ENERGY', 'subs', false, undefined, true);
});

// [A-P1] Defensive prefill guard: a stored row that (illegally) holds BOTH flags must NOT submit
// both — budgetExcluded wins and spread is dropped (server rejects both).
it('[A-P1] a row with BOTH budgetExcluded and spread prefills budgetExcluded only', async () => {
  await openEdit({ budgetExcluded: true, spread: true });
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', true, undefined, false);
});
