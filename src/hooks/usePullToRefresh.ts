import { useCallback, useState } from 'react';

// WHIT-363 / WHIT-489: the shared pull-to-refresh handler for the list tabs (Transactions,
// Accounts). Pull refreshes the visible list AND fetches fresh account balances live from the
// bank. The `pulling` flag owns the pull spinner — set on the pull, cleared in a `.finally()`
// only once BOTH the list refetch and the live balance call settle (never off the query's raw
// `isFetching`) — so a slow or failed live call can't wedge the spinner. A failed live refresh
// keeps the last-good balances and just toasts; it never blanks the list.
//
// Extracted from the two screens (WHIT-489) so the invariant lives in one place. Callers keep
// their own `refreshing` gate on the RefreshControl (the two screens gate it differently).
//
// `successMessage` (optional): a screen passes it to confirm a successful pull. A live-balance
// refresh often returns the SAME number (the balance didn't move, or the server's 60s throttle
// returned the stored values), and success is otherwise silent — so an unchanged pull looks
// broken. Accounts passes "Balances up to date" so the pull always gives visible feedback;
// screens that omit it keep the silent-on-success behaviour.
export function usePullToRefresh(
  refetchList: () => Promise<unknown>,
  refreshLiveBalances: () => Promise<unknown>,
  showToast: (message: string) => void,
  successMessage?: string,
): { pulling: boolean; onRefresh: () => void } {
  const [pulling, setPulling] = useState(false);
  const onRefresh = useCallback(() => {
    setPulling(true);
    const livePull = refreshLiveBalances()
      .then(() => { if (successMessage) showToast(successMessage); })
      .catch(() => showToast('Could not refresh balances. Showing last saved.'));
    Promise.allSettled([refetchList(), livePull]).finally(() => setPulling(false));
  }, [refetchList, refreshLiveBalances, showToast, successMessage]);
  return { pulling, onRefresh };
}
