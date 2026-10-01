// The query-cache keys, in a leaf file (WHIT-630) so the read hooks (queries.ts), the store's
// write paths (context.tsx) and the cached-copy patcher (transactionCache.ts) all share one
// name per list — a typo is a compile error, not a list that silently never refreshes.
export const categoriesKey = ['categories'] as const;
export const payCycleKey = ['payCycle'] as const;
// Budgets are un-windowed at the KEY (WHIT-72): the server derives the pay-cycle window
// itself (GET /budgets ignores the client ?days=), so a flat key is correct — it lets
// budgets fetch in PARALLEL with the pay cycle (no waterfall) and refetch exactly ONCE on
// a cycle-length change (the explicit invalidate of budgetsKey in persistPayCycle),
// rather than a length change shifting the key AND the invalidate firing two fetches.
export const budgetsKey = ['budgets'] as const;
// The transactions behind one budget's total (the budget-detail list). A per-id key so
// each budget caches independently; the categorise writes invalidate the flat prefix so
// re-tagging a charge refreshes every cached budget's list.
export const budgetTransactionsKey = ['budgetTransactions'] as const;
// The transactions behind one /breakdown row (the category drill-in list). Keyed per
// category AND cycle so each look-back caches independently, like the breakdown query.
export const categoryTransactionsKey = ['categoryTransactions'] as const;
// Breakdown (spend-by-category, the Insights tab) is the same — server-derived window, so
// a flat key: parallel fetch, single invalidate on a length change (WHIT-72).
export const breakdownKey = ['breakdown'] as const;
// The Transactions tab's cursor-paged, all-accounts FEED (the "Load More" history). Held as
// an infinite query under this flat key; the optimistic write paths map over its InfiniteData pages.
export const transactionsKey = ['transactions'] as const;
// The Uncategorized tab's OWN cursor-paged feed: each page is real uncategorized rows from
// full history (server-filtered, same rule as the count), so the tab lists actual unfiled
// charges via "Load More" instead of client-filtering the general feed's loaded pages. A
// SEPARATE infinite-query key from transactionsKey so the two feeds page independently.
export const uncategorizedFeedKey = ['uncategorizedFeed'] as const;
// The BOUNDED "recent" list (the server's rolling window) behind the tab-bar dot, the
// account-detail screen, and the goal-edit picker. A SEPARATE key from the feed so those
// counts stay fixed and can't drift as the tab pages back through full history.
export const transactionsRecentKey = ['transactionsRecent'] as const;
// The Transactions-tab search over ALL history (WHIT-576): one flat result per [tab, query].
// The optimistic write paths patch and invalidate this prefix.
export const transactionsSearchKey = ['transactionsSearch'] as const;
// The full-history uncategorized count (WHIT-500/501) behind the tab badge, the tab-bar dot,
// and the "All caught up" empty state — a single server number that reflects ALL history, not
// just the loaded pages. The categorise + delete-category writes invalidate it.
export const uncategorizedCountKey = ['uncategorizedCount'] as const;
// The unfiled charges grouped by shop, behind the "File by shop" screen (WHIT-517). Whole-history
// server grouping. refreshAfterApplyRules invalidates it after any rule sweep, so a filed shop
// leaves the list.
export const uncategorizedMerchantsKey = ['uncategorizedMerchants'] as const;
// Rules suggested from the user's hand-filing habits, behind the "File by shop" screen (WHIT-542).
// Whole-history server walk. refreshAfterApplyRules invalidates it after any rule sweep, so a shop
// that just got a rule (or had its charges filed) drops off the suggestions.
export const filingSuggestionsKey = ['filingSuggestions'] as const;
// Loan facts (the Settings "Loan details" row + the loan form). Un-windowed flat key; the
// saveLoanFacts write updates it.
export const loanFactsKey = ['loanFacts'] as const;
// The live home-loan balance + the last repayment (the Goal tab + milestone screen).
// Un-windowed flat keys — WHIT-197. No write path touches them (balance is poller-fed,
// repayment is server-derived).
export const homeLoanKey = ['homeLoan'] as const;
export const repaymentKey = ['repayment'] as const;
// The live per-account balances (the Accounts tab + account-detail header) — WHIT-212.
// Un-windowed flat key, poller-fed like the home-loan balance, so no write path touches it.
export const accountBalancesKey = ['accountBalances'] as const;
// The categorisation rules (the Rules screen). Un-windowed flat key; the rule writes
// double-write it — WHIT-195.
export const rulesKey = ['rules'] as const;
// The user's savings/debt goals (the Goals hub) — WHIT-233. Un-windowed flat key; the goal
// writes update it.
export const goalsKey = ['goals'] as const;
// The user's saved home-loan milestone plan (the milestone + mortgage screens) — WHIT-367.
// Un-windowed flat key; the milestone save updates it.
export const milestonesKey = ['milestones'] as const;
