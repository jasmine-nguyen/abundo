// WHIT-562 — regression guard: the SINGLE description-contains ("classic") path is UNTOUCHED by the
// new multi-condition overlap warning. A classic rule that clashes with an existing rule must still
// go through the OLD ruleConflict flow (testID `rule-conflict`, with Replace/Cancel), NOT the new
// soft `rule-overlap` warning. Companion to AddRuleSheetOverlapWarning.screen.test.tsx (the multi
// path). If someone routed the classic path through ruleOverlap, `rule-overlap` would appear here.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => mockState };
});
jest.mock('../queries', () => require('./support/screenQueryMocks').queryMocksFromState(() => mockState));

import { Overlays } from '../components/Overlays';

const fns = {
  updateRule: jest.fn(),
  saveManualRule: jest.fn(),
  setSheet: jest.fn(),
  readSheetDraft: () => undefined,
  writeSheetDraft: () => {},
};

const CATS = [
  { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
  { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
];

// An existing CLASSIC rule (no `conditions`) filing COLESSHOP as Groceries.
const colesGroceries = { id: 'g1', pattern: 'COLESSHOP', categoryId: 'groceries', isNew: false };

function newState(over: Partial<Record<string, unknown>> = {}): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, transactions: [], ...fns, ...over } as unknown as AppContext;
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

// [A34] classic single description-contains rule clashing on category -> OLD ruleConflict path.
it('a clashing classic rule shows rule-conflict (Replace/Cancel), never rule-overlap', () => {
  mockState = newState({ rules: [colesGroceries] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'COLESSHOP');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-submit'));

  expect(screen.getByTestId('rule-conflict')).toBeTruthy();
  expect(screen.getByTestId('rule-conflict-replace')).toBeTruthy();
  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

// [A35] a NON-clashing classic rule takes the classic confirm step, still not the overlap path.
it('a non-clashing classic rule routes to the addRuleConfirm step, not rule-overlap', () => {
  mockState = newState({ rules: [] });
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'NETFLIXSUB');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-submit'));

  expect(screen.queryByTestId('rule-overlap')).toBeNull();
  expect(screen.queryByTestId('rule-conflict')).toBeNull();
  expect(fns.setSheet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm', pattern: 'NETFLIXSUB', categoryId: 'subs' }));
});
