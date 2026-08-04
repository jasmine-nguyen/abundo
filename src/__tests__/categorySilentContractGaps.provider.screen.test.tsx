// WHIT-437 — [A20]-[A26] the `silent` contract AFTER the change: a silent write now REJECTS so
// the caller can quote the server, but the three FALSY-return paths it kept must stay falsy.
//
// The implementer pinned "silent + rejected api call → rejects" (appProvider.screen.test.tsx).
// The gaps here are the paths that must NOT have become throws — a blank name, a mid-flight
// sign-out, and saveCategory's create DELEGATION, which forwards `opts` into
// createCategoryInline and is the only place the new throw crosses a function boundary.
// If any of these started throwing, app/category/edit.tsx's catch would toast
// "Could not save category. Please try again." over a sign-out (WHIT-282) or re-throw a blank
// name into the console (WHIT-249).
//
// Harness mirrors sessionGuardRollbacksGaps.provider.screen.test.tsx: live mini auth store,
// mocked ../api, the real queryClient, sign-out = clear() then broadcast 'anon'.
import { it, expect, jest, beforeEach, afterEach, describe } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

let mockStatus: 'loading' | 'authed' | 'anon' | 'locked' = 'authed';
const mockListeners = new Set<() => void>();
const mockSetStatus = (s: typeof mockStatus) => { mockStatus = s; mockListeners.forEach((l) => l()); };
const mockSubscribe = (l: () => void) => { mockListeners.add(l); return () => mockListeners.delete(l); };

jest.mock('../auth', () => ({ getStatus: () => mockStatus, subscribe: (l: () => void) => mockSubscribe(l) }));
jest.mock('../api');
jest.mock('../queries', () => ({
  ...require('./support/screenQueryMocks').queryMocksFromState(() => ({})),
  useIsAuthed: () => {
    const ReactActual = require('react') as typeof React;
    return ReactActual.useSyncExternalStore(mockSubscribe, () => mockStatus === 'authed');
  },
}));

import { AppProvider, useAppContext } from '../context';
import type { Bucket } from '../context';
import { queryClient } from '../queryClient';
import { ApiError } from '../apiError';
import * as api from '../api';
const mockApi = api as jest.Mocked<typeof api>;

const wrapper = ({ children }: { children: React.ReactNode }) => <AppProvider>{children}</AppProvider>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function signOut() { act(() => { queryClient.clear(); mockSetStatus('anon'); }); }

const CAP = 'a category can have at most 50 sub-categories';
const FORM = { name: 'Gym', bucket: 'Lifestyle' as Bucket, icon: 'dumbbell' };
const SILENT = { silent: true };

beforeEach(() => { mockStatus = 'authed'; mockListeners.clear(); queryClient.clear(); });
afterEach(() => { queryClient.clear(); });

describe('[A20] saveCategory delegates a CREATE — the reason must survive the hop', () => {
  // saveCategory(null, form, opts) is `return (await createCategoryInline(form, opts)) !== null`.
  // The `!== null` reads like a swallow; it is not — the await re-throws. Pinned because the
  // obvious "fix" (wrapping the delegation in its own try) would silently drop the reason.
  it('rejects with the SAME ApiError, reason intact, and fires no toast', async () => {
    const refusal = new ApiError(400, CAP);
    mockApi.createCategory.mockRejectedValue(refusal as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let caught: unknown = 'never rejected';
    await act(async () => {
      caught = await result.current.saveCategory(null, FORM, SILENT).then(() => 'resolved', (e: unknown) => e);
    });
    expect(caught).toBe(refusal);                       // the identical object, not a re-wrap
    expect((caught as ApiError).serverMessage).toBe(CAP);
    expect(result.current.toast).toBeNull();            // WHIT-240: silent still means silent
  });

  it('rejects on the NON-silent create path only by returning false + toasting the reason', async () => {
    mockApi.createCategory.mockRejectedValue(new ApiError(409, 'category already exists') as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory(null, FORM).then((v) => v, (e: unknown) => e);
    });
    expect(returned).toBe(false);                       // no throw escapes the default path
    expect(result.current.toast).toBe('Category already exists.');
  });
});

describe('[A21][A22] a blank name is a validation bail, never a rejection', () => {
  // Guarded BEFORE the try, so it can't reach the new `throw`. edit.tsx's canSave blocks this
  // today, but Overlays/QuickCreateCategory trim independently — a regression here would surface
  // as a red console.error from useInFlightGuard on a whitespace name.
  it('createCategoryInline({ name: "   " }, { silent: true }) resolves null and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.createCategoryInline({ ...FORM, name: '   ' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBeNull();
    expect(mockApi.createCategory).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
  });

  it('saveCategory(null, { name: "" }, { silent: true }) resolves false and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory(null, { ...FORM, name: '' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBe(false);
    expect(mockApi.createCategory).not.toHaveBeenCalled();
  });

  it('saveCategory("gym", { name: "   " }, { silent: true }) resolves false and never calls the API', async () => {
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let returned: unknown = 'unset';
    await act(async () => {
      returned = await result.current.saveCategory('gym', { ...FORM, name: '   ' }, SILENT)
        .then((v) => v, (e: unknown) => ({ threw: e }));
    });
    expect(returned).toBe(false);
    expect(mockApi.updateCategory).not.toHaveBeenCalled();
  });
});

describe('[A23] a SIGN-OUT mid-flight keeps the falsy return — it must not become a rejection', () => {
  // The epoch check sits ABOVE the `if (opts?.silent) throw error`. If the order were swapped,
  // signing out during a bulk save would reject → edit.tsx's catch runs → the WHIT-282 guard
  // there catches it, but a NULL-reason network error would ALSO be re-thrown into
  // console.error. Order matters; pin it.
  it('createCategoryInline silent + failed + signed out → resolves null, no toast, no throw', async () => {
    const d = deferred<never>();
    mockApi.createCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.createCategoryInline(FORM, SILENT).then((v) => v, (e: unknown) => ({ threw: e })); });
    signOut();
    let returned: unknown = 'unset';
    await act(async () => { d.reject(new ApiError(400, CAP)); returned = await pending; });

    expect(returned).toBeNull();
    expect(result.current.toast).toBeNull();
  });

  it('saveCategory (update) silent + failed + signed out → resolves false, no toast, no throw', async () => {
    const d = deferred<never>();
    mockApi.updateCategory.mockImplementation(() => d.promise as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });

    let pending!: Promise<unknown>;
    act(() => { pending = result.current.saveCategory('gym', FORM, SILENT).then((v) => v, (e: unknown) => ({ threw: e })); });
    signOut();
    let returned: unknown = 'unset';
    await act(async () => { d.reject(new ApiError(400, CAP)); returned = await pending; });

    expect(returned).toBe(false);
    expect(result.current.toast).toBeNull();
  });
});

describe('[A26] a silent SUCCESS is unchanged', () => {
  it('createCategoryInline silent returns the created row with no toast', async () => {
    mockApi.createCategory.mockResolvedValue({ id: 'gym', name: 'Gym', bucket: 'Lifestyle', icon: 'dumbbell', color: '#fff' } as never);
    const { result } = renderHook(() => useAppContext(), { wrapper });
    let created: unknown = 'unset';
    await act(async () => { created = await result.current.createCategoryInline(FORM, SILENT); });
    expect(created).toMatchObject({ id: 'gym', name: 'Gym' });
    expect(result.current.toast).toBeNull();
  });
});
