// WHIT-670 QA (slice 3) — the picker and confirm pop-ups over the fake server and the real query
// hooks: where the tapped charge is resolved from, what shows when the charge or category is
// missing, a failed or slow categories reply, a mid-session category, and staying open (with its
// fold state) across a context redraw.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import type { AppContext } from '../context';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { Overlays } from '../components/Overlays';
import { categoriesKey } from '../queryKeys';
import { queryClient } from '../queryClient';
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { refreshInAct, useTestQueryClient, WithQueries } from './support/renderWithQueries';
import { openOverlays, overlaysTree } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const TX = { transaction_id: 't1', amount: -12, description: 'CAFE NERO', merchant_name: 'Cafe Nero' };
const cat = (id: string, name: string, parent: string | null = null) => ({ id, name, icon: 'tag', bucket: 'Lifestyle', parent });
const FAMILY = [cat('food', 'Food'), cat('dining', 'Dining', 'food'), cat('transport', 'Transport')];

const fns = {
  chooseCategory: jest.fn(), applyCategory: jest.fn(), applyCategoryToMany: jest.fn(),
  createCategoryInline: jest.fn(), setSheet: jest.fn(),
  readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};

beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockClear());
  resetAuth();
});

const setMockState = (next: AppContext) => { mockState = next; };
const stateFor = (sheet: Record<string, unknown>) => ({ sheet, toast: null, ...fns } as unknown as AppContext);
const pickerNames = () => screen.queryAllByTestId('pickerCat-name').map((n) => n.props.children);

describe('picker resolves the tapped charge from the real caches', () => {
  // [A1] (P0)
  it('[A1] a charge only in the recent list (feed empty) still opens the picker', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'picker', txId: 't1' }), setMockState);

    expect(screen.getByText('Categorise')).toBeTruthy();
    expect(screen.getByText('-$12.00')).toBeTruthy();
    expect(pickerNames()).toEqual(['Food', 'Dining', 'Transport']);
  });

  // [A2] (P0)
  it('[A2] a charge only in the feed (recent list empty) still opens the picker', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions/feed', { transactions: [TX], nextCursor: null });
    await openOverlays(stateFor({ mode: 'picker', txId: 't1' }), setMockState);

    expect(screen.getByText('-$12.00')).toBeTruthy();
  });

  // [A3] (P1)
  it('[A3] a charge the server does not have draws no picker at all', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'picker', txId: 'gone' }), setMockState);

    expect(screen.queryByText('Categorise')).toBeNull();
    expect(pickerNames()).toEqual([]);
  });
});

describe('picker over a failed or slow categories reply', () => {
  // [A4] (P1)
  it('[A4] a 500 on /categories still shows the charge and the New category row, but no categories', async () => {
    server.fail('/categories', 500);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'picker', txId: 't1' }), setMockState);

    expect(screen.getByText('-$12.00')).toBeTruthy();
    expect(screen.getByTestId('pickerNewCategory')).toBeTruthy();
    expect(pickerNames()).toEqual([]);
  });

  // [A5] (P1)
  it('[A5] the categories fill in once a held reply lands, with the picker already open', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    const held = server.hold('/categories');
    mockState = stateFor({ mode: 'picker', txId: 't1' });
    render(<WithQueries><Overlays /></WithQueries>);
    await waitFor(() => expect(screen.getByText('-$12.00')).toBeTruthy());
    expect(pickerNames()).toEqual([]);

    await act(async () => held.release());
    await waitFor(() => expect(pickerNames()).toEqual(['Food', 'Dining', 'Transport']));
  });

  // [A6] (P1)
  it('[A6] a category added on the server shows after the categories cache refreshes', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'picker', txId: 't1' }), setMockState);
    expect(pickerNames()).not.toContain('Gym');

    server.seed('/categories', [...FAMILY, cat('gym', 'Gym')]);
    await refreshInAct(() => queryClient.invalidateQueries({ queryKey: categoriesKey }));

    await waitFor(() => expect(pickerNames()).toEqual(['Food', 'Dining', 'Gym', 'Transport']));
  });
});

describe('picker stays open across a context redraw', () => {
  // [A7] (P0)
  it('[A7] a toast landing keeps the picker open, its fold state intact, and fires no pick', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    const { rerender } = await openOverlays(stateFor({ mode: 'picker', txId: 't1' }), setMockState);
    fireEvent.press(screen.getByTestId('pickerCat-toggle-food'));
    expect(screen.queryByText('Dining')).toBeNull();

    await act(async () => {
      mockState = { ...mockState, toast: 'Filed something elsewhere' } as unknown as AppContext;
      rerender(overlaysTree());
    });

    expect(screen.getByText('Categorise')).toBeTruthy();
    expect(screen.queryByText('Dining')).toBeNull();
    expect((screen.getByTestId('pickerCat-toggle-food').props as any).accessibilityState.expanded).toBe(false);
    expect(fns.chooseCategory).not.toHaveBeenCalled();
  });
});

describe('confirm pop-ups over the real category and charge caches', () => {
  // [A8] (P1)
  it('[A8] confirm for a category the server does not have draws nothing', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'confirm', txId: 't1', categoryId: 'ghost' }), setMockState);

    expect(screen.queryByText('All from this merchant')).toBeNull();
    expect(screen.queryByText('Just this one')).toBeNull();
  });

  // [A9] (P1)
  it('[A9] confirm for a charge the server does not have draws nothing', async () => {
    server.seed('/categories', FAMILY);
    await openOverlays(stateFor({ mode: 'confirm', txId: 't1', categoryId: 'food' }), setMockState);

    expect(screen.queryByText('File as Food')).toBeNull();
    expect(screen.queryByText('Just this one')).toBeNull();
  });

  // [A10] (P1)
  it('[A10] confirm resolves a charge only in the recent list and files it', async () => {
    server.seed('/categories', FAMILY);
    server.seed('/transactions', [TX]);
    await openOverlays(stateFor({ mode: 'confirm', txId: 't1', categoryId: 'dining' }), setMockState);

    expect(screen.getByText('File as Dining')).toBeTruthy();
    fireEvent.press(screen.getByText('Just this one'));
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });

  // [A11] (P1)
  it('[A11] confirmMany over a failed categories reply draws nothing and files nothing', async () => {
    server.fail('/categories', 500);
    await openOverlays(stateFor({ mode: 'confirmMany', txIds: ['t1', 't2'], categoryId: 'food' }), setMockState);

    expect(screen.queryByText('File 2 transactions')).toBeNull();
    expect(fns.applyCategoryToMany).not.toHaveBeenCalled();
  });

  // [A12] (P2)
  it('[A12] confirmMany uses the category name from the server for a child category', async () => {
    server.seed('/categories', FAMILY);
    await openOverlays(stateFor({ mode: 'confirmMany', txIds: ['t1', 't2'], categoryId: 'dining' }), setMockState);

    expect(screen.getByText('File as Dining')).toBeTruthy();
    expect(screen.getByText('Re-file 2 transactions under Dining.')).toBeTruthy();
  });
});
