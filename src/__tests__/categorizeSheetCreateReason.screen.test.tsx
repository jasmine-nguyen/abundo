// WHIT-437 — [A30]-[A34] the categorise sheet's quick-create, END TO END.
//
// This is the cheapest real proof in the card: src/components/Overlays.tsx `createAndFile`
// inherits the whole fix with ZERO code change of its own, because it calls
// createCategoryInline WITHOUT `{ silent: true }`. That means every assumption is untested by
// construction — nothing in Overlays.tsx would go red if the inheritance broke. The existing
// coverage stops at the provider (appProvider.screen.test.tsx), so nothing yet proves the
// reason travels api → context → the toast a user actually sees on this screen.
//
// Real components all the way down (real AppProvider, real Overlays, real
// QuickCreateCategory); only ../api and ../auth are mocked. The assertion is the rendered
// toast TEXT, not a spy.
// Harness mirrors overlaysPickerCreateDraft.screen.test.tsx.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { Text } from 'react-native';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
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
import { ApiError } from '../apiError';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

let ctx!: ReturnType<typeof useAppContext>;
function Probe() { ctx = useAppContext(); return <Text testID="probe">probe</Text>; }
function renderOverlays() { return render(<AppProvider><Probe /><Overlays /></AppProvider>); }

const NAME_INPUT = 'Category name';
const CAP = 'a category can have at most 50 sub-categories';

beforeEach(() => {
  mockStatus = 'authed';
  mockListeners.clear();
  mockState = {
    transactions: [{ transaction_id: 't1', amount: -12, description: 'CAFE', merchant_name: 'Cafe' }],
    categories: [],
  };
  queryClient.clear();
});
afterEach(() => { queryClient.clear(); });

/** Open the picker for t1, switch to the inline create form, and type a name. */
function fillCreateForm(name = 'Gym') {
  renderOverlays();
  act(() => ctx.openPicker('t1'));
  fireEvent.press(screen.getByTestId('pickerNewCategory'));
  fireEvent.changeText(screen.getByPlaceholderText(NAME_INPUT), name);
}
const submit = async () => { await act(async () => { fireEvent.press(screen.getByText('Create & file')); }); };

describe('the sheet shows the server reason instead of "Please try again"', () => {
  // [A30] the card's headline promise, on the path that got no code change.
  it('renders the refusal reason in the toast', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(400, CAP) as never);
    fillCreateForm();
    await submit();

    expect(await screen.findByText('A category can have at most 50 sub-categories.')).toBeTruthy();
    expect(screen.queryByText('Could not save category. Please try again.')).toBeNull();
  });

  // [A31] the most reachable real refusal by hand — a name that already exists.
  it('renders a 409 duplicate refusal', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(409, 'category already exists') as never);
    fillCreateForm('Groceries');
    await submit();

    expect(await screen.findByText('Category already exists.')).toBeTruthy();
  });

  // [A32] a refusal must NOT file the transaction, and must leave the form usable for a retry —
  // createAndFile only calls setSubmitting(false) on the null branch, so a stuck busy flag here
  // would trap the user on a dead form with no error recovery.
  it('does not file the transaction and re-enables the form for a retry', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(400, CAP) as never);
    fillCreateForm();
    await submit();
    await screen.findByText('A category can have at most 50 sub-categories.');

    expect(mockApi.setTransactionFields).not.toHaveBeenCalled();
    expect(mockApi.setTransactionCategories).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(NAME_INPUT).props.value).toBe('Gym');  // still on the form

    // The button works again: a second press reaches the API a second time.
    await submit();
    await waitFor(() => expect(mockApi.createCategory).toHaveBeenCalledTimes(2));
  });
});

describe('the generic copy still covers what is not ours to quote', () => {
  // [A33] a 5xx is our fault; "try again" is honest there and must survive.
  it('renders the generic copy for a 500 that did explain itself', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(500, 'DynamoDB ProvisionedThroughputExceeded') as never);
    fillCreateForm();
    await submit();

    expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/DynamoDB/)).toBeNull();
  });

  // [A34] offline: a plain Error carries nothing, so nothing may be invented.
  it('renders the generic copy for a network failure', async () => {
    mockApi.createCategory.mockRejectedValue(new TypeError('Network request failed') as never);
    fillCreateForm();
    await submit();

    expect(await screen.findByText('Could not save category. Please try again.')).toBeTruthy();
  });
});
