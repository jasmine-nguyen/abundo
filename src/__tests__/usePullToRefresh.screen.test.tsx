// WHIT-489 / WHIT-363 — the shared pull-to-refresh hook now owns the stuck-spinner invariant
// for the list tabs. This is its unit-level home: `pulling` flips true on a pull, both refreshes
// fire, and `pulling` clears ONLY after BOTH settle (Promise.allSettled) — never wedged by a
// slow/failed live-balance call. A failed live call toasts the exact copy and still clears; a
// success is silent unless a `successMessage` is passed (then it confirms the pull); a second
// pull after a failed first is not latched.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';
import { usePullToRefresh } from '../hooks/usePullToRefresh';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let refetchList: jest.Mock<() => Promise<unknown>>;
let refreshLiveBalances: jest.Mock<() => Promise<unknown>>;
let showToast: jest.Mock<(m: string) => void>;

beforeEach(() => {
  refetchList = jest.fn(() => Promise.resolve());
  refreshLiveBalances = jest.fn(() => Promise.resolve());
  showToast = jest.fn();
});

describe('usePullToRefresh', () => {
  it('starts not pulling', () => {
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));
    expect(result.current.pulling).toBe(false);
  });

  it('raises the spinner and fires both refreshes on a pull', () => {
    const list = deferred<void>();
    const bal = deferred<void>();
    refetchList.mockReturnValueOnce(list.promise);
    refreshLiveBalances.mockReturnValueOnce(bal.promise);
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));

    act(() => { result.current.onRefresh(); });
    expect(result.current.pulling).toBe(true);
    expect(refetchList).toHaveBeenCalledTimes(1);
    expect(refreshLiveBalances).toHaveBeenCalledTimes(1);
  });

  it('clears the spinner ONLY after BOTH calls settle', async () => {
    const list = deferred<void>();
    const bal = deferred<void>();
    refetchList.mockReturnValueOnce(list.promise);
    refreshLiveBalances.mockReturnValueOnce(bal.promise);
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));

    act(() => { result.current.onRefresh(); });
    // Only the list has settled — the live call is still in flight → still pulling.
    await act(async () => { list.resolve(); await Promise.resolve(); });
    expect(result.current.pulling).toBe(true);
    // Now the live call settles too → spinner clears.
    await act(async () => { bal.resolve(); await Promise.resolve(); });
    expect(result.current.pulling).toBe(false);
  });

  it('a failed live refresh toasts the exact copy and still clears the spinner', async () => {
    refreshLiveBalances.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));

    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(showToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
    expect(result.current.pulling).toBe(false);
  });

  it('a successful pull does not toast when no success message is given', async () => {
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(showToast).not.toHaveBeenCalled();
    expect(result.current.pulling).toBe(false);
  });

  it('toasts the success message on a successful pull when one is provided', async () => {
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast, 'Balances up to date'));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(showToast).toHaveBeenCalledWith('Balances up to date');
    expect(result.current.pulling).toBe(false);
  });

  it('does NOT toast the success message when the live refresh fails', async () => {
    refreshLiveBalances.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast, 'Balances up to date'));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(showToast).toHaveBeenCalledWith('Could not refresh balances. Showing last saved.');
    expect(showToast).not.toHaveBeenCalledWith('Balances up to date');
  });

  it('refetches the list even when the live balance call rejects', async () => {
    refreshLiveBalances.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(refetchList).toHaveBeenCalledTimes(1);
  });

  it('is not latched: a second pull after a failed first fires again and clears', async () => {
    refreshLiveBalances.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const { result } = renderHook(() => usePullToRefresh(refetchList, refreshLiveBalances, showToast));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.pulling).toBe(false);

    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); });
    expect(refreshLiveBalances).toHaveBeenCalledTimes(2);
    expect(refetchList).toHaveBeenCalledTimes(2);
    expect(result.current.pulling).toBe(false);
  });
});
