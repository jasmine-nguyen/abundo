// WHIT-843 — tapping a transaction row opens its details. A filed row (any category, Income
// included) routes to /transaction/<id> from anywhere on the row body; an unfiled row still
// opens the category picker; select mode still toggles selection. The body is never disabled,
// so it takes the shared PRESSED look on press (WHIT-184 intent: no disabled look).
import { it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, resetRouter } from './support/routerMock';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';
import { pressedStyle } from './support/pressedStyle';
import type { Category } from '../types';
import { PRESSED } from '../theme';

let mockState: { openPicker: jest.Mock; category: (id: string | null) => Category | undefined };
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import { TransactionRow } from '../components/TransactionRow';

type Node = { props: { style: unknown; disabled?: boolean } };

beforeEach(() => {
  resetRouter();
  mockState = { openPicker: jest.fn(), category: makeState({ categories: [cat()] }).category };
});

it.each([
  { row: 'a filed row', category: 'coffee', label: 'Cafes & Coffee', selectable: false, push: '/transaction/tx1', picker: false, toggled: false },
  { row: 'an Income row', category: 'income', label: 'Income', selectable: false, push: '/transaction/tx1', picker: false, toggled: false },
  { row: 'an unfiled row', category: null, label: 'Uncategorized', selectable: false, push: null, picker: true, toggled: false },
  { row: 'a filed row in select mode', category: 'coffee', label: 'Cafes & Coffee', selectable: true, push: null, picker: false, toggled: true },
])('tapping the body of $row → details: $push, picker: $picker, selected: $toggled', ({ category, label, selectable, push, picker, toggled }) => {
  const onToggleSelect = jest.fn();
  const { UNSAFE_root } = render(
    <TransactionRow
      t={txn({ transaction_id: 'tx1', category })}
      category={mockState.category}
      selectable={selectable}
      onToggleSelect={onToggleSelect}
    />,
  );

  const body = (UNSAFE_root as unknown as { findAll: (p: (n: Node) => boolean) => Node[] })
    .findAll((n) => typeof n.props?.style === 'function')[0];
  expect(body.props.disabled).toBeFalsy();
  expect(pressedStyle(body, true).opacity).toBe(PRESSED.opacity);
  expect(pressedStyle(body, false).opacity).toBeUndefined();

  // In select mode the body is hidden from screen readers, so reach it past that.
  fireEvent.press(screen.getByText(label, { includeHiddenElements: true }));

  if (push) expect(routerSpies.push).toHaveBeenCalledWith(push);
  else expect(routerSpies.push).not.toHaveBeenCalled();
  if (picker) expect(mockState.openPicker).toHaveBeenCalledWith('tx1');
  else expect(mockState.openPicker).not.toHaveBeenCalled();
  expect(onToggleSelect).toHaveBeenCalledTimes(toggled ? 1 : 0);
});
