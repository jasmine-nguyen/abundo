// WHIT-283 GAP — the bucket + icon + parent halves must RESTORE AND RENDER AS SELECTED after a
// Face ID lock, not merely be written to the draft store. The implementer's suite
// (overlaysPickerCreateDraft.screen.test.tsx) asserts the store CONTENTS (readSheetDraft) BEFORE the
// lock; it never proves the reopened form re-selects the chosen bucket/icon/parent, nor that the
// persist effect (which re-fires on the restored mount) doesn't clobber a good draft back to
// defaults via the lazy-init-before-effect ordering. Harness mirrors overlaysPickerCreateDraft.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, fireEvent } from '@testing-library/react-native';
import { BUCKET_COLOR } from '../context';
import { C } from '../theme';

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

// Flatten an RN style prop (object | array | nested arrays) to one object, so a selected/unselected
// colour can be read regardless of how the component composes its styles.
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return style.reduce((acc: Record<string, unknown>, s) => Object.assign(acc, flat(s)), {});
  return (style ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  mockState = {
    transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }],
    // One same-bucket (Lifestyle == the form's initialBucket) category, so the inline form's parent
    // picker offers it — required for the parent round-trip.
    categories: [{ id: 'coffee', name: 'Coffee', icon: 'coffee', color: '#e8a87c', bucket: 'Lifestyle', recent: 0, parent: null }],
  };
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

function openCreateForm() {
  act(() => ctx.openPicker('t1'));
  fireEvent.press(screen.getByTestId('pickerNewCategory')); // list -> inline create form
}

describe('WHIT-283 GAP — the restored form RE-SELECTS bucket / icon / parent after unlock', () => {
  // [G1] Round-trip RENDER of bucket + icon (the implementer only checks the store write pre-lock).
  it('[G1] bucket + icon selection survive the lock and RENDER as selected on unlock (not just the store)', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Gym');
    fireEvent.press(screen.getByText('Living'));       // a non-default bucket (default is Lifestyle)
    fireEvent.press(screen.getByTestId('icon-cart'));  // a non-default icon (default is coffee)

    act(() => mockSetStatus('locked'));  // overlay layer unmounts (WHIT-268 shield)
    act(() => mockSetStatus('authed'));  // restored mount

    // The reopened form must SHOW the choices selected: the bucket label paints in its bucket colour
    // and the icon tile borders in the accent ONLY when selected.
    expect(flat(screen.getByText('Living').props.style).color).toBe(BUCKET_COLOR.Living);
    expect(flat(screen.getByTestId('icon-cart').props.style).borderColor).toBe(C.accent);
    // A sibling control must NOT read as selected — guards a "everything looks selected" false pass.
    expect(flat(screen.getByText('Income').props.style).color).not.toBe(BUCKET_COLOR.Income);
    expect(flat(screen.getByTestId('icon-coffee').props.style).borderColor).toBe('rgba(255,255,255,.07)');

    // Clobber guard: the persist effect re-fires on the restored mount. Because the field state
    // lazy-inits FROM the draft before that effect writes committed state, the stored draft must be
    // unchanged — not reset to the {bucket:'Lifestyle', icon:'coffee'} defaults.
    expect(ctx.readSheetDraft('pickercat:t1')).toEqual({ name: 'Gym', bucket: 'Living', icon: 'cart', parent: null });
  });

  // [G2] Round-trip RENDER of a picked parent (implementer only ever persists parent:null across a
  // lock; pickerSheetParentPick pick->submit never locks).
  it('[G2] a picked parent survives the lock and RENDERS as the selected parent on unlock', () => {
    renderOverlays();
    openCreateForm();
    fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), 'Beans');
    fireEvent.press(screen.getByText('Coffee'));       // the same-bucket parent (initialBucket Lifestyle)
    expect(ctx.readSheetDraft('pickercat:t1')).toMatchObject({ parent: 'coffee' });

    act(() => mockSetStatus('locked'));
    act(() => mockSetStatus('authed'));

    // Reopened: the 'Coffee' parent chip reads selected (painted in the category's colour) and the
    // 'None' chip does not.
    expect(flat(screen.getByText('Coffee').props.style).color).toBe('#e8a87c');
    expect(flat(screen.getByText('None').props.style).color).not.toBe(C.accentSofter);
    expect(ctx.readSheetDraft('pickercat:t1')).toMatchObject({ name: 'Beans', parent: 'coffee' });
  });
});
