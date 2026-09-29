// WHIT-654 QA — the Delete button on the transaction detail screen: the confirm wording and style,
// double taps, the in-flight state, a throwing writer, the only-cached-row case, and no button on
// "not found". The context writer is mocked; the screen is real.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({
  useTransactionDetailScreenData: () => mockTx,
  useTransactionResolver: () => ({
    transactions: mockTx.transactions,
    findTx: (id: string) => (mockTx.transactions as { transaction_id: string }[]).find((t) => t.transaction_id === id),
  }),
  useBudgetsScreenData: () => ({ budgets: [] }),
  useRulesScreenData: () => ({ rules: [], isLoading: false }),
}));

const mockDeleteTransaction = jest.fn<(txId: string) => Promise<boolean>>();
jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return {
    ...actual,
    useAppContext: () => ({
      applyTransactionEdit: jest.fn(),
      showToast: jest.fn(),
      openPicker: jest.fn(),
      deleteTransaction: mockDeleteTransaction,
    }),
  };
});

let mockId = 't1';
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockId }),
  useRouter: () => ({ back: mockBack, push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category;

function txData(over: Partial<{ transactions: unknown[]; isLoading: boolean; isError: boolean }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: 'coffee' })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

type AlertButton = { text: string; style?: string; onPress?: () => void };
let alertSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  mockId = 't1';
  mockTx = txData();
  mockBack.mockClear();
  mockDeleteTransaction.mockReset();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { alertSpy.mockRestore(); });

function openConfirm() {
  fireEvent.press(screen.getByTestId('transaction-delete'));
  const [title, message, buttons] = alertSpy.mock.calls[alertSpy.mock.calls.length - 1] as [string, string, AlertButton[]];
  return { title, message, buttons, confirm: buttons.find((button) => button.text === 'Delete')! };
}

// [C1]
it('the confirm says it cannot be undone and Delete is the destructive choice', () => {
  render(<TransactionDetail />);
  const { title, message, buttons, confirm } = openConfirm();
  expect(title).toBe('Delete this transaction?');
  expect(message).toMatch(/can't be undone/);
  expect(confirm.style).toBe('destructive');
  expect(buttons.find((button) => button.text === 'Cancel')?.style).toBe('cancel');
  expect(mockDeleteTransaction).not.toHaveBeenCalled();
});

// [C2]
it('a double confirm in the same frame deletes once and goes back once', async () => {
  mockDeleteTransaction.mockResolvedValue(true);
  render(<TransactionDetail />);
  const { confirm } = openConfirm();

  await act(async () => { confirm.onPress?.(); confirm.onPress?.(); });

  expect(mockDeleteTransaction).toHaveBeenCalledTimes(1);
  expect(mockBack).toHaveBeenCalledTimes(1);
});

// [C3]
it('while the delete runs the button says "Deleting…" and is disabled', async () => {
  let finish: (ok: boolean) => void = () => {};
  mockDeleteTransaction.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<TransactionDetail />);

  await act(async () => { openConfirm().confirm.onPress?.(); });

  const button = screen.getByTestId('transaction-delete');
  expect(screen.getByText('Deleting…')).toBeTruthy();
  expect(button.props.accessibilityState).toEqual({ disabled: true });

  await act(async () => { finish(false); });
  expect(screen.getByText('Delete transaction')).toBeTruthy();
  expect(mockBack).not.toHaveBeenCalled();
});

// [C4]
it('a writer that throws leaves the user on the screen with the button re-enabled', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockDeleteTransaction.mockRejectedValue(new Error('boom'));
  render(<TransactionDetail />);

  await act(async () => { openConfirm().confirm.onPress?.(); });

  expect(mockBack).not.toHaveBeenCalled();
  expect(screen.getByTestId('transaction-delete').props.accessibilityState).toEqual({ disabled: false });
  consoleError.mockRestore();
});

// [C5]
it('deleting the ONLY cached charge never flashes the empty/loading states before going back', async () => {
  let finish: (ok: boolean) => void = () => {};
  mockDeleteTransaction.mockImplementation(() => {
    mockTx = txData({ transactions: [], isLoading: true });
    return new Promise((resolve) => { finish = resolve; });
  });
  const view = render(<TransactionDetail />);

  await act(async () => { openConfirm().confirm.onPress?.(); });
  view.rerender(<TransactionDetail />);

  expect(screen.queryByText('Transaction not found')).toBeNull();
  expect(screen.getByTestId('transaction-delete')).toBeTruthy();

  await act(async () => { finish(true); });
  expect(mockBack).toHaveBeenCalledTimes(1);
});

// [C6]
it('a stale id shows "not found" with no Delete button', () => {
  mockId = 'gone';
  render(<TransactionDetail />);
  expect(screen.getByText('Transaction not found')).toBeTruthy();
  expect(screen.queryByTestId('transaction-delete')).toBeNull();
});
