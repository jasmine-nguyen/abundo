// WHIT-275 — the note + tags editor on the transaction detail screen. Renders the REAL
// screen and its data code over the pretend server (WHIT-686), with a seeded transaction;
// ../context is partially mocked (real selectors, stubbed useAppContext so the edit action is a
// spy); expo-router + safe-area stubbed. Verifies the note saves via an explicit Save button —
// not on blur (WHIT-843: leaving the screen saves it) — tags add on submit/comma, duplicate tags are ignored, and a chip's ✕
// removes it.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { setParams, resetRouter } from './support/routerMock';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react-native';
import { txn } from './factory';
import type { Transaction } from '../types';

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

function seedRow(over: Partial<Transaction> = {}) {
  server.seed('/transactions/feed', { transactions: [txn({ transaction_id: 't1', category: 'coffee', ...over })], nextCursor: null });
}

const draw = () => renderWithQueries(<TransactionDetail />);

beforeEach(() => {
  resetRouter();
  setParams({ id: 't1' });
  resetAuth();
  mockEdit.mockClear();
  mockToast.mockClear();
  server.seed('/categories', [{ ...COFFEE_RECORD, parent: null }]);
  seedRow({ notes: 'old note', tags: ['work'] });
});

// WHIT-280: a small helper to seed a transaction already carrying `count` distinct tags.
const withTags = (count: number) => seedRow({ tags: Array.from({ length: count }, (_, i) => `t${i}`) });

it('renders the existing note and tag chips', async () => {
  await draw();
  expect(screen.getByDisplayValue('old note')).toBeTruthy();
  expect(screen.getByText('work')).toBeTruthy();
});

it('saves an edited note when Save note is tapped', async () => {
  await draw();
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'new note');
  fireEvent.press(screen.getByTestId('note-save'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'new note' });
});

it('does NOT save on blur — the note commits only via Save', async () => {
  await draw();
  const note = screen.getByTestId('note-input');
  fireEvent.changeText(note, 'new note');
  fireEvent(note, 'blur');
  expect(mockEdit).not.toHaveBeenCalled();
});

// WHIT-846: no dim, always-there button — Save note shows only once the note has been edited.
it('Save note only shows once the note is edited', async () => {
  await draw();
  expect(screen.queryByTestId('note-save')).toBeNull();
  fireEvent.changeText(screen.getByTestId('note-input'), 'new note');
  expect(screen.getByTestId('note-save')).toBeTruthy();
  // [A3] typed back to the saved note (bar stray spaces) → nothing to save, so it hides again
  fireEvent.changeText(screen.getByTestId('note-input'), ' old note ');
  expect(screen.queryByTestId('note-save')).toBeNull();
});

// WHIT-843 (decision A): leaving saves an edited note once with the LATEST text (typed twice, so a
// save using the first-render text would fail); an unchanged note writes nothing on leave.
it.each([
  { case: 'an edited note is saved once with the latest text', typed: ['first draft', 'latest note'], saved: 'latest note' },
  { case: 'an unchanged note is not saved', typed: [], saved: null },
])('leaving the details screen: $case', async ({ typed, saved }) => {
  const view = await draw();
  for (const text of typed) fireEvent.changeText(screen.getByTestId('note-input'), text);

  view.unmount();

  if (saved === null) {
    expect(mockEdit).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
    return;
  }
  expect(mockEdit).toHaveBeenCalledTimes(1);
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: saved });
  expect(mockToast).toHaveBeenCalledWith('Note saved'); // [A1] sign-off Q1: say it was saved
});

it('saves the note exactly once per Save tap', async () => {
  await draw();
  fireEvent.changeText(screen.getByTestId('note-input'), 'edited');
  fireEvent.press(screen.getByTestId('note-save'));
  expect(mockEdit).toHaveBeenCalledTimes(1);
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'edited' });
});

it('adds a tag on submit, appending to the existing tags', async () => {
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'travel');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: ['work', 'travel'] });
});

it('adds a tag on a trailing comma', async () => {
  await draw();
  fireEvent.changeText(screen.getByTestId('tag-input'), 'travel,');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: ['work', 'travel'] });
});

it('ignores a duplicate tag (case-insensitive)', async () => {
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'WORK');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('removes a tag via its ✕ button', async () => {
  await draw();
  fireEvent.press(screen.getByLabelText('Remove tag work'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: [] });
});

// WHIT-280: the pre-flight tag-count guard.
it('at 20 tags, a new tag is refused with a friendly toast and is not saved', async () => {
  withTags(20);
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'overflow');
  fireEvent(input, 'submitEditing');
  expect(mockToast).toHaveBeenCalledWith('Up to 20 tags.');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('at 20 tags, the comma path is also guarded', async () => {
  withTags(20);
  await draw();
  fireEvent.changeText(screen.getByTestId('tag-input'), 'overflow,');
  expect(mockToast).toHaveBeenCalledWith('Up to 20 tags.');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('at 20 tags, re-typing an existing tag stays a silent no-op (dedupe before the cap nudge)', async () => {
  withTags(20);
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 't5'); // already present
  fireEvent(input, 'submitEditing');
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
});

it('under the cap (19 tags) a new tag still adds normally', async () => {
  withTags(19);
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, 'twenty');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).toHaveBeenCalledWith('t1', { tags: [...Array.from({ length: 19 }, (_, i) => `t${i}`), 'twenty'] });
  expect(mockToast).not.toHaveBeenCalled();
});

// WHIT-280 — [A10] at the cap, whitespace-only entry must NOT toast: the empty-input
// early-return runs BEFORE the count guard, so a stray space/comma at 20 tags is a
// silent no-op, not a spurious "Up to 20 tags." nudge. Locks that ordering.
it('at 20 tags, whitespace-only entry is a silent no-op (no toast, no save)', async () => {
  withTags(20);
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, '   ');
  fireEvent(input, 'submitEditing');
  fireEvent.changeText(input, '   ,'); // comma path with only whitespace before it
  expect(mockToast).not.toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
});

// WHIT-296 — the "Exclude from budgets / Mark as transfer" toggle.
const withExcluded = (excluded?: boolean) => seedRow({ budget_excluded: excluded });

it('renders the exclude toggle OFF when the charge is not excluded', async () => {
  withExcluded(undefined);
  await draw();
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' }).props.accessibilityState.checked).toBe(false);
});

it('renders the exclude toggle ON when the charge is already excluded', async () => {
  withExcluded(true);
  await draw();
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' }).props.accessibilityState.checked).toBe(true);
});

it('tapping the toggle when off requests exclusion', async () => {
  withExcluded(undefined);
  await draw();
  fireEvent.press(screen.getByRole('switch', { name: 'Exclude from budgets' }));
  expect(mockEdit).toHaveBeenCalledWith('t1', { budget_excluded: true });
});

it('tapping the toggle when on requests re-inclusion', async () => {
  withExcluded(true);
  await draw();
  fireEvent.press(screen.getByRole('switch', { name: 'Exclude from budgets' }));
  expect(mockEdit).toHaveBeenCalledWith('t1', { budget_excluded: false });
});

// WHIT-846: money coming in (a refund or transfer in) gets its own exclude wording; spend keeps
// "Exclude from budgets" (covered by the toggle and read-only note tests). Both the manual switch
// and the bank's read-only note.
it.each([
  { case: 'money in, manual switch', over: { amount: 25 }, shown: 'Leave this money out', hidden: 'Exclude from budgets' },
  { case: 'money in, bank-excluded', over: { amount: 25, counts_to_budget: false }, shown: 'This looks like a transfer in, so it doesn\'t count toward budgets or insights.', hidden: 'This looks like a transfer or card payment, so it doesn\'t count toward budgets or insights.' },
])('exclude wording: $case', async ({ over, shown, hidden }) => {
  seedRow(over);
  await draw();
  expect(screen.getByText(shown)).toBeTruthy();
  expect(screen.queryByText(hidden)).toBeNull();
});

// WHIT-298 — a BANK-excluded charge (counts_to_budget false) shows a read-only note IN PLACE
// OF the manual toggle (the toggle can't un-exclude a bank transfer, so it would be inert).
const bankExcluded = () => seedRow({ counts_to_budget: false });

it('shows the read-only "Excluded (transfer)" note when the bank auto-excluded the charge', async () => {
  bankExcluded();
  await draw();
  expect(screen.getByText('Excluded (transfer)')).toBeTruthy();
  expect(screen.getByText(/doesn't count toward budgets or insights/)).toBeTruthy();
});

it('hides the manual exclude toggle when the bank already excluded the charge', async () => {
  bankExcluded();
  await draw();
  expect(screen.queryByRole('switch', { name: 'Exclude from budgets' })).toBeNull();
});

it('keeps the manual toggle (and no read-only note) on a normal counted charge', async () => {
  seedRow(); // counts_to_budget defaults true
  await draw();
  expect(screen.getByRole('switch', { name: 'Exclude from budgets' })).toBeTruthy();
  expect(screen.queryByText('Excluded (transfer)')).toBeNull();
});

// WHIT-275 adversarial gaps — the edges the suite above misses: whitespace-only / bare-comma tag
// submits are no-ops; Save trims whitespace.
it('does NOT commit a whitespace-only tag on submit', async () => { // [A16]
  await draw();
  const input = screen.getByTestId('tag-input');
  fireEvent.changeText(input, '   ');
  fireEvent(input, 'submitEditing');
  expect(mockEdit).not.toHaveBeenCalled(); // trimmed-empty tag is dropped, not persisted
});

it('does NOT commit a bare-comma tag input', async () => { // [A17]
  await draw();
  // A lone "," commits an empty candidate → trimmed-empty → dropped.
  fireEvent.changeText(screen.getByTestId('tag-input'), ',');
  expect(mockEdit).not.toHaveBeenCalled();
});

it('Save trims surrounding whitespace before persisting', async () => { // [A20]
  await draw();
  fireEvent.changeText(screen.getByTestId('note-input'), '  padded note  ');
  fireEvent.press(screen.getByTestId('note-save'));
  expect(mockEdit).toHaveBeenCalledWith('t1', { notes: 'padded note' });
});
