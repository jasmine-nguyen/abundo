// WHIT-291 — the picker/confirm sheets in their multi-select ('*Many') modes. The picker shows
// the selection COUNT (no single merchant/amount) and advances chooseCategory on a pick; the
// confirm files the whole captured set via applyCategoryToMany. Drives the real sheets through
// <Overlays/> with a mocked context for client state and writers; the categories come from the
// fake server through the real query hooks (WHIT-670).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import type { AppContext } from '../context';

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

const fns = {
  chooseCategory: jest.fn(), applyCategoryToMany: jest.fn(), createCategoryInline: jest.fn(),
  setSheet: jest.fn(), readSheetDraft: jest.fn(() => undefined), writeSheetDraft: jest.fn(),
};
beforeEach(() => {
  Object.values(fns).forEach((f) => f.mockClear());
  resetAuth();
});

function openSheet(sheet: Record<string, unknown>) {
  server.seed('/categories', [GROCERIES_TOP_RECORD]);
  const state = { sheet, toast: null, ...fns } as unknown as AppContext;
  return openOverlays(state, (next) => { mockState = next; });
}

describe('multi-select picker (WHIT-291)', () => {
  it('pickerMany shows the selection count and advances chooseCategory on a pick', async () => {
    await openSheet({ mode: 'pickerMany', txIds: ['t1', 't2', 't3'] });
    expect(screen.getByText('3 transactions')).toBeTruthy(); // count header, not a merchant/amount

    fireEvent.press(screen.getByText('Groceries'));
    expect(fns.chooseCategory).toHaveBeenCalledWith('groceries');
  });

  it('confirmMany files the whole captured set via applyCategoryToMany', async () => {
    await openSheet({ mode: 'confirmMany', txIds: ['t1', 't2', 't3'], categoryId: 'groceries' });
    expect(screen.getByText('File 3 transactions')).toBeTruthy();

    fireEvent.press(screen.getByText('File 3 transactions'));
    expect(fns.applyCategoryToMany).toHaveBeenCalledTimes(1);
    expect(fns.applyCategoryToMany).toHaveBeenCalledWith(['t1', 't2', 't3'], 'groceries');
  });

  it('singular copy for a one-item selection', async () => {
    await openSheet({ mode: 'confirmMany', txIds: ['t1'], categoryId: 'groceries' });
    expect(screen.getByText('File 1 transaction')).toBeTruthy(); // not "1 transactions"
  });
});
