// WHIT-283 — the picker's inline new-category form must survive a Face ID lock, like WHIT-277 did
// for the add-rule / goal-balance sheets. The whole overlay layer unmounts while locked (Overlays'
// WHIT-268 shield), destroying PickerSheet's `creating` flag + QuickCreateCategory's fields; both
// are stashed in the WHIT-277 draft store and restored on unlock. These pin: the form reopens with
// its fields intact (not the category list); nothing renders while locked; cleared on close /
// sign-out / cancel. Harness mirrors overlaysSheetDraft.screen.test.tsx.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, fireEvent } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
jest.mock('../api');

let mockState: { transactions?: unknown[]; categories?: unknown[] } = {};
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => mockState),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
}));

import { AppProvider, useAppContext } from '../context';
import { Overlays } from '../components/Overlays';
import { queryClient } from '../queryClient';

let ctx!: ReturnType<typeof useAppContext>;
function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
function renderOverlays() {
  return render(<AppProvider><Probe /><Overlays /></AppProvider>);
}

const NAME_INPUT = 'Category name';

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  mockState = { transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }], categories: [] };
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

function openCreateForm() {
  act(() => ctx.openPicker('t1'));
  fireEvent.press(screen.getByTestId('pickerNewCategory')); // list → inline create form
}

describe('WHIT-283 — picker inline-create draft survives a Face ID lock', () => {
  it('restores the half-typed name and reopens INTO the create form (not the list) across a lock', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');

    // Lock: the whole overlay layer unmounts (WHIT-268 shield) — the form is gone.
    act(() => mockSetStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();

    // Unlock: the picker reopens straight into the create form with the name restored.
    act(() => mockSetStatus('authed'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');
    expect(screen.getByText('New category')).toBeTruthy();       // the form title
    expect(screen.queryByTestId('pickerNewCategory')).toBeNull(); // NOT back on the list
  });

  it('persists all fields (name + bucket + icon) to the draft store', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));    // pick a non-default bucket
    fireEvent.press(screen.getByTestId('icon-cart')); // pick a non-default icon

    // The persist effect writes the whole draft (raw name) under the txId-scoped key.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  it('renders nothing category-related while locked, even with a draft stashed (WHIT-268 intact)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'SecretCat');

    act(() => mockSetStatus('locked'));
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull();
    expect(screen.queryByDisplayValue('SecretCat')).toBeNull();
    expect(screen.queryByText('New category')).toBeNull();
  });

  it('clears the draft on sheet close — reopening the picker starts on the list with an empty form', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => ctx.setSheet(null));       // close the whole sheet (clears all drafts)
    act(() => ctx.openPicker('t1'));     // reopen
    expect(screen.queryByPlaceholderText(NAME_INPUT)).toBeNull(); // back on the list, form not open
    expect(screen.getByTestId('pickerNewCategory')).toBeTruthy();
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe(''); // fresh empty form
  });

  it('clears the draft on sign-out (no cross-user leak)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    act(() => mockSetStatus('anon'));  // sign-out hard-clears drafts + the sheet
    act(() => mockSetStatus('authed'));
    openCreateForm();
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('');
  });

  it('Cancel discards the draft — reopening the create form starts empty', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');

    fireEvent.press(screen.getByText('Cancel')); // back to the list, draft discarded
    fireEvent.press(screen.getByTestId('pickerNewCategory'));
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('');
  });
});
