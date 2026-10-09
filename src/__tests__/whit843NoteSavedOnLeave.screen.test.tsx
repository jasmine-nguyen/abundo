// WHIT-843 (decision A) — leaving the transaction details screen with a typed but unsaved note
// saves it once, with the LATEST text; an unchanged note writes nothing on leave.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';

const mockEdit = jest.fn();
const mockToast = jest.fn();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({ applyTransactionEdit: mockEdit, showToast: mockToast })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries } from './support/renderWithQueries';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => {
  resetRouter();
  setParams({ id: 't1' });
  resetAuth();
  mockEdit.mockClear();
  mockToast.mockClear();
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  server.seed('/transactions/feed', {
    transactions: [txn({ transaction_id: 't1', category: 'coffee', notes: 'old note', tags: ['work'] })],
    nextCursor: null,
  });
});

it.each([
  { case: 'an edited note is saved once with the latest text', typed: ['first draft', 'latest note'], saved: 'latest note' },
  { case: 'an unchanged note is not saved', typed: [], saved: null },
])('leaving the details screen: $case', async ({ typed, saved }) => {
  const view = await renderWithQueries(<TransactionDetail />);
  for (const text of typed) fireEvent.changeText(screen.getByTestId('note-input'), text);

  view.unmount();

  if (saved === null) {
    expect(mockEdit).not.toHaveBeenCalled();
    return;
  }
  expect(mockEdit).toHaveBeenCalledTimes(1);
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: saved });
});
