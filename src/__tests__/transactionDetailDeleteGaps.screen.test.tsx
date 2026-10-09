// WHIT-654 QA — the Delete button on the transaction detail screen: the confirm wording and style,
// double taps, the in-flight state, a throwing writer, the only-cached-row case, and no button on
// "not found". The context writer is mocked; the screen and its data code are real, over the
// pretend server (WHIT-686).
import { it, expect, jest, beforeEach } from '@jest/globals';
import { routerSpies, setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';

const mockDeleteTransaction = jest.fn<(txId: string) => Promise<boolean>>();
const mockEdit = jest.fn();
jest.mock('../context', () =>
  require('./support/contextMock').realContextWith(() => ({
    applyTransactionEdit: mockEdit,
    showToast: jest.fn(),
    openPicker: jest.fn(),
    deleteTransaction: mockDeleteTransaction,
  })),
);
jest.mock('../auth', () => require('./support/authMock').authMockModule());

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

import TransactionDetail from '../../app/transaction/[id]';
import { resetAuth } from './support/authMock';
import { spyOnAlert } from './support/alertSpy';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient, renderWithQueries, refreshInAct } from './support/renderWithQueries';
import { queryClient } from '../queryClient';
import { transactionsKey } from '../queryKeys';
import { COFFEE_RECORD } from './support/categories';

const server = installFakeServer();
useTestQueryClient();
const alerts = spyOnAlert();

beforeEach(() => {
  resetRouter();
  resetAuth();
  setParams({ id: 't1' });
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 't1', category: 'coffee' })], nextCursor: null });
  mockDeleteTransaction.mockReset();
  mockEdit.mockClear();
});

const draw = () => renderWithQueries(<TransactionDetail />);

function openConfirm() {
  fireEvent.press(screen.getByTestId('transaction-delete'));
  const last = alerts.last();
  return { ...last, confirm: last.button('Delete') };
}

// [C1]
it('the confirm says it cannot be undone and Delete is the destructive choice', async () => {
  await draw();
  const { title, message, button, confirm } = openConfirm();
  expect(title).toBe('Delete this transaction?');
  expect(message).toMatch(/can't be undone/);
  expect(confirm.style).toBe('destructive');
  expect(button('Cancel').style).toBe('cancel');
  expect(mockDeleteTransaction).not.toHaveBeenCalled();
});

// [C2]
it('a double confirm in the same frame deletes once and goes back once', async () => {
  mockDeleteTransaction.mockResolvedValue(true);
  await draw();
  const { confirm } = openConfirm();

  await refreshInAct(() => { confirm.onPress?.(); confirm.onPress?.(); });

  expect(mockDeleteTransaction).toHaveBeenCalledTimes(1);
  expect(routerSpies.back).toHaveBeenCalledTimes(1);
});

// [C3]
it('while the delete runs the button says "Deleting…" and is disabled', async () => {
  let finish: (ok: boolean) => void = () => {};
  mockDeleteTransaction.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await draw();

  await refreshInAct(() => { openConfirm().confirm.onPress?.(); });

  const button = screen.getByTestId('transaction-delete');
  expect(screen.getByText('Deleting…')).toBeTruthy();
  expect(button.props.accessibilityState).toEqual({ disabled: true });

  await refreshInAct(() => finish(false));
  expect(screen.getByText('Delete transaction')).toBeTruthy();
  expect(routerSpies.back).not.toHaveBeenCalled();
});

// [C4]
it('a writer that throws leaves the user on the screen with the button re-enabled', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockDeleteTransaction.mockRejectedValue(new Error('boom'));
  await draw();

  await refreshInAct(() => { openConfirm().confirm.onPress?.(); });

  expect(routerSpies.back).not.toHaveBeenCalled();
  expect(screen.getByTestId('transaction-delete').props.accessibilityState).toEqual({ disabled: false });
  consoleError.mockRestore();
});

// [C5] The delete empties every list cache and the feed is reloading with nothing cached — the
// screen would normally show its spinner, but it keeps the charge up until the delete answers.
it('deleting the ONLY cached charge never flashes the empty/loading states before going back', async () => {
  let finish: (ok: boolean) => void = () => {};
  mockDeleteTransaction.mockImplementation(() => {
    void queryClient.resetQueries({ queryKey: transactionsKey });
    return new Promise((resolve) => { finish = resolve; });
  });
  await draw();
  const reload = server.hold('/transactions/feed');

  await refreshInAct(() => { openConfirm().confirm.onPress?.(); });

  expect(queryClient.getQueryState(transactionsKey)?.status).toBe('pending');
  expect(screen.queryByTestId('transaction-loading')).toBeNull();
  expect(screen.queryByText('Transaction not found')).toBeNull();
  expect(screen.getByTestId('transaction-delete')).toBeTruthy();

  await refreshInAct(() => finish(true));
  expect(routerSpies.back).toHaveBeenCalledTimes(1);
  await refreshInAct(() => reload.release());
});

// WHIT-843: leaving saves an edited note, but not after a delete — the charge is gone.
it('after a successful delete, leaving does not save an edited note', async () => {
  mockDeleteTransaction.mockResolvedValue(true);
  const view = await draw();
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited');

  await refreshInAct(() => { openConfirm().confirm.onPress?.(); });
  view.unmount();

  expect(routerSpies.back).toHaveBeenCalledTimes(1);
  expect(mockEdit).not.toHaveBeenCalled();
});

// [C6]
it('a stale id shows "not found" with no Delete button', async () => {
  setParams({ id: 'gone' });
  await draw();
  expect(screen.getByText('Transaction not found')).toBeTruthy();
  expect(screen.queryByTestId('transaction-delete')).toBeNull();
});
