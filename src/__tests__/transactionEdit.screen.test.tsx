// WHIT-275 — the note + tags editor on the transaction detail screen. Renders the REAL
// screen with a seeded cached transaction (../queries mocked); ../context is partially
// mocked (real selectors, stubbed useAppContext so the edit action is a spy); expo-router +
// safe-area stubbed. Verifies the note saves via an explicit Save button — not on
// blur/unmount — tags add on submit/comma, duplicate tags are ignored, and a chip's ✕ removes it.
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

it('saves an edited note when Save note is tapped', () => {
  render(<TransactionDetail />);
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'new note');
  fireEvent.press(screen.getByTestId('note-save'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'new note' });
});

it('does NOT save on blur — the note commits only via Save', () => {
  render(<TransactionDetail />);
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'new note');
  fireEvent(note, 'blur');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('Save note is disabled (a no-op) when the note is unchanged', () => {
  render(<TransactionDetail />);
  const save = screen.getByTestId('note-save');
  expect(save.props.accessibilityState).toMatchObject({ disabled: true });
  fireEvent.press(save);
  expect(mockEdit).not.toHaveBeenCalled();
});

it('discards an unsaved note edit on unmount (leave-without-Save, like the form screens)', () => {
  // No auto-save on blur/unmount anymore: typing then leaving WITHOUT tapping Save must
  // write nothing — matching the budget/goal/category edit screens.
  const view = render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited');
  view.unmount();
  expect(mockEdit).not.toHaveBeenCalled();
});

it('saves the note exactly once per Save tap', () => {
  render(<TransactionDetail />);
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited');
  fireEvent.press(screen.getByTestId('note-save'));
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

// WHIT-298 — a BANK-excluded charge (counts_to_budget false) shows a read-only note IN PLACE
// OF the manual toggle (the toggle can't un-exclude a bank transfer, so it would be inert).
const bankExcluded = () =>
  txData({ transactions: [txn({ transaction_id: 't1', category: 'coffee', counts_to_budget: false })] });

it('shows the read-only "Excluded (transfer)" note when the bank auto-excluded the charge', () => {
  mockTx = bankExcluded();
  render(<TransactionDetail />);
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.getByText(/doesn't count toward budgets or insights/)).toBeTruthy();
});

it('hides the manual exclude toggle when the bank already excluded the charge', () => {
  mockTx = bankExcluded();
  render(<TransactionDetail />);
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

it('keeps the manual toggle (and no read-only note) on a normal counted charge', () => {
  mockTx = txData(); // counts_to_budget defaults true
  render(<TransactionDetail />);
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' })).toBeTruthy();
  expect(screen.queryByText('Excluded (transfer)')).toBeNull();
});
