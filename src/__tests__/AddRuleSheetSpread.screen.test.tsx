// WHIT-559: the client "Spread this bill" toggle. Implementer coverage — a NEW classic spread rule
// saves DIRECT (skipping the preview/confirm sheet), a non-spread classic rule still previews,
// spread threads through an edit, and spread + budgetExcluded are mutually exclusive in the UI.
import { it, expect, jest, beforeEach } from '@jest/globals';
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
];

function newState(): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, transactions: [], ...fns } as unknown as AppContext;
}

function editState(over: Record<string, unknown>): AppContext {
  return {
    sheet: { mode: 'addrule', ruleId: 'e1' },
    toast: null,
    rules: [{ id: 'e1', pattern: 'ORIGIN ENERGY', categoryId: 'subs', isNew: false, ...over }],
    categories: CATS,
    transactions: [],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => { jest.clearAllMocks(); });

it('a NEW classic spread rule saves directly and skips the preview sheet', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.saveManualRule).toHaveBeenCalledWith('ORIGIN ENERGY', 'subs', false, undefined, true);
  expect(fns.setSheet).not.toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
});

it('a NEW classic NON-spread rule still routes through the preview sheet', () => {
  mockState = newState();
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByText('Add rule'));
  expect(fns.setSheet).toHaveBeenCalledWith(expect.objectContaining({ mode: 'addRuleConfirm' }));
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});

it('editing a spread rule prefills it and rides spread:true through a text-only edit', () => {
  mockState = editState({ spread: true });
  render(<Overlays />);
  fireEvent.changeText(screen.getByDisplayValue('ORIGIN ENERGY'), 'ORIGIN ENERGY BILL');
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY BILL', 'subs', false, undefined, true);
});

it('turning an inherited spread OFF submits spread:false', () => {
  mockState = editState({ spread: true });
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-spread')); // true -> false
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', false, undefined, false);
});

it('turning spread ON clears an inherited budgetExcluded (mutually exclusive)', () => {
  mockState = editState({ budgetExcluded: true });
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', false, undefined, true);
});

it('turning budgetExcluded ON clears an inherited spread (mutually exclusive)', () => {
  mockState = editState({ spread: true });
  render(<Overlays />);
  fireEvent.press(screen.getByTestId('rule-budget-excluded'));
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', true, undefined, false);
});
