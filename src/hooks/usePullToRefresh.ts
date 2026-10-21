import { useCallback, useState } from 'react';
import type { BankSyncStatus } from '../api';

const BALANCES_FAILED_TOAST = 'Could not refresh balances. Showing last saved.';
const SYNC_FAILED_TOAST = "Couldn't get new transactions from your bank. Showing what we have.";
const SYNC_TOASTS: Partial<Record<BankSyncStatus | 'error', string>> = {
  syncing: 'Still syncing with your bank. Pull again in a couple of minutes.',
  failed: SYNC_FAILED_TOAST,
  error: SYNC_FAILED_TOAST,
};

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
//
// WHIT-713: the live-balance call and the toast are optional. Budgets passes only its refetch,
// so a pull refreshes the screen's data alone; the spinner invariant is the same.
//
// ABU-106: `syncBank` (optional) asks the bank for new transactions first; the list reloads
// once it settles, whatever the outcome, while the balances refresh alongside. One toast at the
// end of the pull: a bank sync still running or failed wins over the balance message.
export function usePullToRefresh(
  refetchList: () => Promise<unknown>,
  refreshLiveBalances?: () => Promise<unknown>,
  showToast?: (message: string) => void,
  successMessage?: string,
  syncBank?: () => Promise<{ status: BankSyncStatus }>,
): { pulling: boolean; onRefresh: () => void } {
  const [pulling, setPulling] = useState(false);
  const onRefresh = useCallback(() => {
    setPulling(true);
    let syncOutcome: BankSyncStatus | 'error' | undefined;
    let balanceToast: string | undefined;
    const list = syncBank
      ? syncBank()
        .then((reply) => reply.status, () => 'error' as const)
        .then((status) => { syncOutcome = status; return refetchList(); })
      : refetchList();
    const pulls = [list];
    if (refreshLiveBalances) {
      pulls.push(refreshLiveBalances().then(
        () => { balanceToast = successMessage; },
        () => { balanceToast = BALANCES_FAILED_TOAST; },
      ));
    }
    Promise.allSettled(pulls).finally(() => {
      const toast = (syncOutcome && SYNC_TOASTS[syncOutcome]) ?? balanceToast;
      if (toast) showToast?.(toast);
      setPulling(false);
    });
  }, [refetchList, refreshLiveBalances, showToast, successMessage, syncBank]);
  return { pulling, onRefresh };
}
