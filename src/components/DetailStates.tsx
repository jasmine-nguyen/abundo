import React from 'react';
import { ListStates } from './ListStates';

// WHIT-276: the cache-first loading/error/retry gate shared by the by-id detail screens
// (transaction/[id], account/[id]). Both read one thing from the SAME cached list, so both
// gate the spinner/error the same way: only show them when there is NOTHING cached to render
// yet — a background refetch over cached rows keeps the content up. Each screen supplies its
// own loaded content + its own empty state as children; the blocks themselves are ListStates.
//
// Spinner and error are INDEPENDENT conditions, not an either/or: isLoading and isError come
// from two combined queries and can both be true at once, so both blocks can render stacked.
export function DetailStates({ isLoading, isError, hasCache, idPrefix, errorText, retryLabel, onRetry, children }: {
  isLoading: boolean; isError: boolean; hasCache: boolean;
  idPrefix: string; errorText: string; retryLabel: string;
  onRetry: () => void; children: React.ReactNode;
}) {
  const showSpinner = isLoading && !hasCache;
  const showError = isError && !hasCache;

  return (
    <>
      <ListStates
        showSpinner={showSpinner} showError={showError} idPrefix={idPrefix}
        errorText={errorText} retryLabel={retryLabel} onRetry={onRetry}
      />
      {!showSpinner && !showError && <>{children}</>}
    </>
  );
}
