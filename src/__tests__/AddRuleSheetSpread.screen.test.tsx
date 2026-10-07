// WHIT-559: the client "Spread this bill" toggle. Implementer coverage — a NEW classic spread rule
// saves DIRECT (skipping the preview/confirm sheet), a non-spread classic rule still previews,
// spread threads through an edit, and spread + budgetExcluded are mutually exclusive in the UI.
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
];

async function open(sheet: Record<string, unknown>, rules: unknown[]) {
  server.seed('/categories', CATS);
  server.seed('/rules', rules);
  const state = { sheet, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

const openNew = () => open({ mode: 'addrule' }, []);

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

it('turning an inherited spread OFF submits spread:false', async () => {
  await openEdit({ spread: true });
  fireEvent.press(screen.getByTestId('rule-spread')); // true -> false
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', false, undefined, false);
});

it('turning spread ON clears an inherited budgetExcluded (mutually exclusive)', async () => {
  await openEdit({ budgetExcluded: true });
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', false, undefined, true);
});

it('turning budgetExcluded ON clears an inherited spread (mutually exclusive)', async () => {
  await openEdit({ spread: true });
  fireEvent.press(screen.getByTestId('rule-budget-excluded'));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', true, undefined, false);
});
