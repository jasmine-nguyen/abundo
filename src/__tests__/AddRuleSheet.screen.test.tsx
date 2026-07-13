// Screen test: the AddRuleSheet in EDIT mode (WHIT-52 Slice 3). When the sheet
// carries a ruleId it prefills from that rule, relabels to "Edit rule" /
// "Update rule", and submits via updateRule (not saveManualRule). Context is
// injected via the jest.mock('../context') pattern.
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
  setSheet: jest.fn(), readSheetDraft: () => undefined, writeSheetDraft: () => {},
  dismissNotif: jest.fn(),
};

function editState(): AppContext {
  return {
    sheet: { mode: 'addrule', ruleId: 'e1' },
    toast: null,
    notif: null,
    rules: [{ id: 'e1', pattern: 'NETFLIX', categoryId: 'subs', isNew: false }],
    categories: [
      { id: 'subs', name: 'Subscriptions', icon: 'film', color: '#f0b27a', bucket: 'Lifestyle', recent: 0 },
      { id: 'groceries', name: 'Groceries', icon: 'cart', color: '#7fd49b', bucket: 'Living', recent: 0 },
    ],
    ...fns,
  } as unknown as AppContext;
}

beforeEach(() => {
  fns.updateRule.mockClear();
  fns.saveManualRule.mockClear();
  fns.setSheet.mockClear();
});

it('prefills from the rule and relabels for edit', () => {
  mockState = editState();
  render(<Overlays />);
  expect(screen.getByText('Edit rule')).toBeTruthy();
  expect(screen.getByDisplayValue('NETFLIX')).toBeTruthy();
  expect(screen.getByText('Update rule')).toBeTruthy();
});

it('submitting calls updateRule with the id, not saveManualRule', () => {
  mockState = editState();
  render(<Overlays />);
  fireEvent.press(screen.getByText('Update rule'));
  expect(fns.updateRule).toHaveBeenCalledWith('e1', 'NETFLIX', 'subs');
  expect(fns.saveManualRule).not.toHaveBeenCalled();
});
