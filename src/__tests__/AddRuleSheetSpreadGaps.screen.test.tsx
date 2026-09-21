// WHIT-559 — adversarial GAP coverage for the "Spread this bill" toggle. The implementer's
// AddRuleSheetSpread.screen.test.tsx pins the CLASSIC paths (direct save, preview skip, edit
// prefill, off, mutual-exclusion toggles). These cover the write paths it did NOT:
//   [A-M1] a NEW MULTI-condition spread rule → spread rides as saveManualRule's 5th arg.
//   [A-M2] an EDIT of a MULTI-condition rule with spread on → updateRule's 6th arg.
//   [A-R1] the replace() clash path (NEW classic spread rule hits a different-category rule,
//          user taps Replace) → updateRule gets spread=true (the third, easy-to-regress writer).
//   [A-P1] a defensive stored row carrying BOTH budgetExcluded:true AND spread:true → the draft
//          must submit budgetExcluded (spread dropped): the prefill guard `spread && !budgetExcluded`.
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
  { id: 'bills', name: 'Bills', icon: 'bolt', color: '#7fd49b', bucket: 'Living', recent: 0 },
];

function state(over: Record<string, unknown> = {}): AppContext {
  return { sheet: { mode: 'addrule' }, toast: null, rules: [], categories: CATS, transactions: [], ...fns, ...over } as unknown as AppContext;
}

beforeEach(() => { jest.clearAllMocks(); });

// [A-M1] A NEW multi-condition spread rule saves DIRECT and passes spread as the 5th arg alongside
// the conditions payload. Implementer only tested classic spread; writeMulti() is a separate writer.
it('[A-M1] a NEW multi-condition spread rule threads spread:true into saveManualRule', () => {
  mockState = state();
  render(<Overlays />);
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
it('[A-M2] editing a multi-condition spread rule threads spread:true into updateRule', () => {
  mockState = state({
    sheet: { mode: 'addrule', ruleId: 'm1' },
    rules: [{
      id: 'm1', pattern: 'ORIGIN', categoryId: 'bills', isNew: false,
      field: 'description', operator: 'contains', spread: true,
      conditions: [
        { field: 'description', operator: 'contains', value: 'ORIGIN' },
        { field: 'amount', operator: 'greater_than', value: '100' },
      ],
      logic: 'all',
    }],
  });
  render(<Overlays />);
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
// via updateRule — which must carry spread:true. This is the third write path (not the direct-save
// nor the plain edit) and is the easiest to forget when threading a new flag.
it('[A-R1] Replace on a NEW classic spread rule retargets the clash with spread:true', () => {
  mockState = state({
    rules: [{ id: 'clash', pattern: 'ORIGIN ENERGY', categoryId: 'bills', isNew: false, field: 'description', operator: 'contains' }],
  });
  render(<Overlays />);
  fireEvent.changeText(screen.getByTestId('rule-value-0'), 'ORIGIN ENERGY');
  fireEvent.press(screen.getByText('Subscriptions'));
  fireEvent.press(screen.getByTestId('rule-spread'));
  fireEvent.press(screen.getByText('Add rule')); // clash → Replace prompt, no save yet
  expect(fns.saveManualRule).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('rule-conflict-replace'));
  expect(fns.updateRule).toHaveBeenCalledWith('clash', 'ORIGIN ENERGY', 'subs', false, undefined, true);
});

// [A-P1] Defensive prefill guard: a stored row that (illegally) holds BOTH flags must NOT submit
// both — budgetExcluded wins and spread is dropped (server rejects both). Guards the
// `spread: spreadPrefill && !budgetExcludedPrefill` line at prefill time, before any toggle.
it('[A-P1] a row with BOTH budgetExcluded and spread prefills budgetExcluded only', () => {
  mockState = state({
    sheet: { mode: 'addrule', ruleId: 'e1' },
    rules: [{ id: 'e1', pattern: 'ORIGIN ENERGY', categoryId: 'subs', isNew: false, budgetExcluded: true, spread: true }],
  });
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'ORIGIN ENERGY', 'subs', true, undefined, false);
});
