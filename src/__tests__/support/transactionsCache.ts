// Test support for the Transactions tab's FEED cache. The ['transactions'] query is an
// InfiniteData of pages ({ transactions, nextCursor }) since the "Load More" migration, so
// tests seed and read it through these helpers instead of a flat array — keeping the page/
// cursor shape in one place. seedTransactionsCache defaults to a single end-of-history page
// (nextCursor null); pass rows + a cursor, or seedTransactionsPages, for multi-page cases.
import type { QueryClient } from '@tanstack/react-query';
import type { Transaction } from '../../context';

export interface FeedPage {
  transactions: Transaction[];
  nextCursor: string | null;
}

/** Seed the feed cache as ONE page (newest batch, end-of-history unless a cursor is given).
 *  Accepts partial rows — many provider tests seed only the fields under assertion. */
export function seedTransactionsCache(
  client: QueryClient,
  transactions: readonly Partial<Transaction>[],
  nextCursor: string | null = null,
): void {
  client.setQueryData(['transactions'], { pages: [{ transactions, nextCursor }], pageParams: [undefined] });
}

/** Seed the feed cache as MULTIPLE loaded pages (for Load More / cross-page tests). */
export function seedTransactionsPages(client: QueryClient, pages: FeedPage[]): void {
  const pageParams = pages.map((_, i) => (i === 0 ? undefined : `cursor-${i}`));
  client.setQueryData(['transactions'], { pages, pageParams });
}

/** Read the feed cache back as one flat newest-first list (every loaded page). */
export function readTransactionsCache(client: QueryClient): Transaction[] {
  const data = client.getQueryData<{ pages: FeedPage[] }>(['transactions']);
  return data ? data.pages.flatMap((p) => p.transactions) : [];
}
