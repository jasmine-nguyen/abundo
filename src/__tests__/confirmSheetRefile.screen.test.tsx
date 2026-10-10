// WHIT-324 — the confirm step of a re-categorise. Both entry points (the Transactions list AND
// a transaction's detail screen) now share ONE confirm: "All from this merchant" (a merchant-wide
// rule sweep) alongside "Just this one" (a single re-file). Pre-324 a detail re-file set a
// `refileOnly` flag that collapsed the confirm to a lone Save — that redundant special case is
// gone, so the two entry points behave identically. These drive the real ConfirmSheet through
// <Overlays/> with a mocked context for client state and writers; the tapped charge and the
// categories come from the fake server through the real query hooks (WHIT-670).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { AppContext } from '../context';
import { C } from '../theme';

let mockState: AppContext;
jest.mock('../context', () => require('./support/contextMock').realContextWith(() => mockState));
jest.mock('../auth', () => require('./support/authMock').authMockModule());

import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { GROCERIES_TOP_RECORD } from './support/categories';
import { useTestQueryClient } from './support/renderWithQueries';
import { openOverlays } from './support/openOverlays';

const server = installFakeServer();
useTestQueryClient();

const TX = { transaction_id: 't1', amount: -12.5, description: 'COLES', merchant_name: 'Coles' };

const fns = {
  applyCategory: jest.fn(), chooseCategory: jest.fn(), setSheet: jest.fn(),
  readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockClear());
  resetAuth();
});

// The confirm resolves the tapped charge from the feed and the recent list; seed both.
function openConfirm() {
  server.seed('/categories', [GROCERIES_TOP_RECORD]);
  server.seed('/transactions', [TX]);
  server.seed('/transactions/feed', { transactions: [TX], nextCursor: null });
  const state = { sheet: { mode: 'confirm', txId: 't1', categoryId: 'groceries' }, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, (next) => { mockState = next; });
}

describe('confirm (re-categorise) — one flow for every entry point', () => {
  // WHIT-843: the safe single re-file is the first, primary (accent) button; the rule is secondary.
  it('"Just this one" comes first as the main button', async () => {
    await openConfirm();
    const [first, second] = screen.getAllByText(/All from this merchant|Just this one/);
    expect(first.props.children).toBe('Just this one');
    expect(StyleSheet.flatten(first.props.style).color).toBe(C.accentInk);
    expect(StyleSheet.flatten(second.props.style).color).not.toBe(C.accentInk);
  });

  it('"All from this merchant" files the whole merchant (applyCategory("all"))', async () => {
    await openConfirm();
    fireEvent.press(screen.getByText('All from this merchant'));
    expect(fns.applyCategory).toHaveBeenCalledTimes(1);
    expect(fns.applyCategory).toHaveBeenCalledWith('all');
  });

  it('"Just this one" re-files only this transaction (applyCategory("one"))', async () => {
    await openConfirm();
    fireEvent.press(screen.getByText('Just this one'));
    expect(fns.applyCategory).toHaveBeenCalledTimes(1);
    expect(fns.applyCategory).toHaveBeenCalledWith('one');
  });
});
