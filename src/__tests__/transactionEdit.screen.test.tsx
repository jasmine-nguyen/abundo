// WHIT-275 — the note + tags editor on the transaction detail screen. Renders the REAL
// screen with a seeded cached transaction (../queries mocked); ../context is partially
// mocked (real selectors, stubbed useAppContext so the edit action is a spy); expo-router +
// safe-area stubbed. Verifies the note commits on blur (only when changed), tags add on
// submit/comma, duplicate tags are ignored, and a chip's ✕ removes it.
import { it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { makeState, cat, txn } from './factory';

const mockEdit = jest.fn();
const mockToast = jest.fn();
let mockTx: ReturnType<typeof txData>;
jest.mock('../queries', () => ({ useTransactionsScreenData: () => mockTx }));

jest.mock('../context', () => {
  const actual = jest.requireActual('../context') as typeof import('../context');
  return { ...actual, useAppContext: () => ({ applyTransactionEdit: mockEdit, showToast: mockToast }) };
});
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 't1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import TransactionDetail from '../../app/transaction/[id]';

const category = makeState({ categories: [cat()] }).category;

function txData(over: Partial<{ transactions: unknown[] }> = {}) {
  return {
    transactions: [txn({ transaction_id: 't1', category: 'coffee', notes: 'old note', tags: ['work'] })],
    category, balances: new Map(),
    isLoading: false, isError: false, isFetching: false,
    refetch: jest.fn(), refetchStale: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  mockEdit.mockClear();
  mockToast.mockClear();
  mockTx = txData();
});

// WHIT-280: a small helper to seed a transaction already carrying `count` distinct tags.
const withTags = (count: number) =>
  txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', tags: Array.from({ length: count }, (_, i) => `t${i}`) })] });

it('renders the existing note and tag chips', () => {
  render(<TransactionDetail />);
  expect(screen.getByDisplayValue('old note')).toBeTruthy();
  expect(screen.getByText('work')).toBeTruthy();
});

it('commits an edited note on blur', () => {
  render(<TransactionDetail />);
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'new note');
  fireEvent(note, 'blur');
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'new note' });
});

it('does NOT commit on blur when the note is unchanged', () => {
  render(<TransactionDetail />);
  fireEvent(screen.getByTestId('note-input'), 'blur');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('saves the note only once on edit → blur → unmount (no double-save)', () => {
  // onBlur commits; the unmount flush must see the just-committed value and short-circuit,
  // so the "edit note → tap back" path issues exactly one PATCH, not two.
  const view = render(<TransactionDetail />);
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'edited');
  fireEvent(note, 'blur');
  view.unmount();
  expect(mockEdit).toHaveBeenCalledTimes(1);
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'edited' });
});

it('adds a tag on submit, appending to the existing tags', () => {
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'travel');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: ['work', 'travel'] });
});

it('adds a tag on a trailing comma', () => {
  render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('tag-input'), 'travel,');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: ['work', 'travel'] });
});

it('ignores a duplicate tag (case-insensitive)', () => {
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'WORK');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('removes a tag via its ✕ button', () => {
  render(<TransactionDetail />);
  fireEvent.press(screen.getByLabelText('Remove tag work'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: [] });
});

// WHIT-280: the pre-flight tag-count guard.
it('at 20 tags, a new tag is refused with a friendly toast and is not saved', () => {
  mockTx = withTags(20);
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'overflow');
  fireEvent(input, 'submitEditing');
  expect(mockToast).toHaveBeenCalledWith('Up to 20 tags.');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('at 20 tags, the comma path is also guarded', () => {
  mockTx = withTags(20);
  render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('tag-input'), 'overflow,');
  expect(mockToast).toHaveBeenCalledWith('Up to 20 tags.');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('at 20 tags, re-typing an existing tag stays a silent no-op (dedupe before the cap nudge)', () => {
  mockTx = withTags(20);
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 't5'); // already present
  fireEvent(input, 'submitEditing');
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
});

it('under the cap (19 tags) a new tag still adds normally', () => {
  mockTx = withTags(19);
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'twenty');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: [...Array.from({ length: 19 }, (_, i) => `t${i}`), 'twenty'] });
  expect(mockToast).not.toHaveBeenCalled();
});

// WHIT-280 — [A10] at the cap, whitespace-only entry must NOT toast: the empty-input
// early-return runs BEFORE the count guard, so a stray space/comma at 20 tags is a
// silent no-op, not a spurious "Up to 20 tags." nudge. Locks that ordering.
it('at 20 tags, whitespace-only entry is a silent no-op (no toast, no save)', () => {
  mockTx = withTags(20);
  render(<TransactionDetail />);
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, '   ');
  fireEvent(input, 'submitEditing');
  fireEvent.changeText(input, '   ,'); // comma path with only whitespace before it
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
});

// WHIT-296 — the "Exclude from budgets / Mark as transfer" toggle.
const withExcluded = (excluded?: boolean) =>
  txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', budget_excluded: excluded })] });

it('renders the exclude toggle OFF when the charge is not excluded', () => {
  mockTx = withExcluded(undefined);
  render(<TransactionDetail />);
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' }).props.accessibilityState.checked).toBe(false);
});

it('renders the exclude toggle ON when the charge is already excluded', () => {
  mockTx = withExcluded(true);
  render(<TransactionDetail />);
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' }).props.accessibilityState.checked).toBe(true);
});

it('tapping the toggle when off requests exclusion', () => {
  mockTx = withExcluded(undefined);
  render(<TransactionDetail />);
  fireEvent.press(screen.getByRole('switch', { name: 'Exclude from budgets' }));
  expect(mockEdit).toHaveBeenCalledWith('t1', { budget_excluded: true });
});

it('tapping the toggle when on requests re-inclusion', () => {
  mockTx = withExcluded(true);
  render(<TransactionDetail />);
  fireEvent.press(screen.getByRole('switch', { name: 'Exclude from budgets' }));
  expect(mockEdit).toHaveBeenCalledWith('t1', { budget_excluded: false });
});
