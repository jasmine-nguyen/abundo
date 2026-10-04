// WHIT-558 gap — the edit-mode toggle survives an unrelated field change, and can be turned OFF.
// The implementer pins prefill-then-submit-unchanged and toggle-on. The adversarial edges here:
//   1. a rule with the flag ON, edit ONLY the pattern text (never touch the toggle) → the prefilled
//      exclusion must ride through into updateRule (the shared draft object must not drop it when a
//      sibling field changes). Fail-on-revert: have setPattern return a fresh {pattern} object and
//      the flag is lost → updateRule gets false.
//   2. the user's hand wins at the UI too: a rule with the flag ON, tap the toggle OFF → updateRule
//      gets false (the toggle is genuinely two-way, not write-once).
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
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
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
};

async function openEdit(budgetExcluded: boolean) {
  server.seed('/categories', [SUBSCRIPTIONS_RECORD]);
  server.seed('/rules', [{ id: 'e1', value: 'NETFLIX', categoryId: 'subs', budgetExcluded }]);
  const state = { sheet: { mode: 'addrule', ruleId: 'e1' }, toast: null, ...fns } as unknown as AppContext;
  await openOverlays(state, (next) => { mockState = next; });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAuth();
});

it('editing only the pattern preserves the prefilled budgetExcluded:true', async () => {
  await openEdit(true);
  fireEvent.changeText(screen.getByDisplayValue('NETFLIX'), 'NETFLIX PREMIUM');
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX PREMIUM', 'subs', true, undefined, false);
});

it('turning an inherited exclusion OFF submits budgetExcluded:false', async () => {
  await openEdit(true);
  fireEvent.press(screen.getByTestId('rule-budget-excluded')); // true -> false
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs', false, undefined, false);
});
