import { Transaction, Category, Bucket } from "./context";
import { getAuthToken } from "./auth";
const API_BASE = "https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com";

/**
 * Build the Authorization header from the Cognito ID token (WHIT-162). Every app
 * route is now guarded by the API Gateway JWT authorizer, so the token is the
 * user's Cognito ID token (`getAuthToken`), not the old baked-in static secret —
 * which has been retired. Throws "Not signed in" when there is no session, so a
 * pre-login fetch fails loudly (the caller catches it) rather than sending an
 * empty Bearer and getting a confusing 401 on every call. The auth gate
 * (src/AuthGate.tsx) forces login before the app is usable, and src/context.tsx
 * reloads once auth lands, so this throw is only hit transiently before sign-in.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const idToken = await getAuthToken();
  if (!idToken) throw new Error("Not signed in");
  return { Authorization: `Bearer ${idToken}` };
}

/**
 * The single async choke point for request headers: merge any per-call headers
 * (e.g. Content-Type) with the auth header. Routing EVERY call site through this
 * one `await` is what makes the async cutover safe — a spread of a Promise
 * (`...authHeaders()` once it returns a Promise) would silently drop the auth
 * header, so no call site is allowed to build headers by hand.
 */
async function buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  return { ...(extra ?? {}), ...(await authHeaders()) };
}

/** A BankSync-backed categorisation rule, as returned by the /enrichments API. */
export interface EnrichmentRule {
  id: string;
  field: "description" | "category";
  operator: "contains" | "equals";
  value: string;
  categoryId: string;
}

/**
 * Fetch every transaction for the account.
 *
 * @returns The full list of transactions from the API.
 * @throws If the response status is not OK.
 */
export async function fetchTransactions(): Promise<Transaction[]> {
  const response = await fetch(`${API_BASE}/transactions`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Fetch the full category taxonomy.
 *
 * @returns The list of categories from the API.
 * @throws If the response status is not OK.
 */
export async function fetchCategories(): Promise<Category[]> {
  const response = await fetch(`${API_BASE}/categories`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Create a new category. The server derives the immutable id/slug from the name
 * and owns the color; only name, bucket, and icon are client-supplied.
 *
 * @param input - The new category's name, bucket, and icon.
 * @returns The created category, including its server-assigned id and color.
 * @throws If the response status is not OK (e.g. 409 when the slug already exists).
 */
export async function createCategory(
  input: { name: string; bucket: Bucket; icon: string }
): Promise<Category> {
  const response = await fetch(`${API_BASE}/categories`, {
    method: "POST",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Update an existing category's name, bucket, and icon. The id/slug is immutable
 * and the color is server-owned, so neither can be changed here.
 *
 * @param id - The immutable category id/slug (e.g. "groceries").
 * @param input - The category's new name, bucket, and icon.
 * @returns The updated category.
 * @throws If the response status is not OK (e.g. 404 when the id is unknown).
 */
export async function updateCategory(
  id: string,
  input: { name: string; bucket: Bucket; icon: string }
): Promise<Category> {
  const response = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Hard-delete a category. The server does no cascade, so transactions still
 * pointing at the deleted id render as Uncategorized client-side.
 *
 * @param id - The immutable category id/slug to delete (e.g. "groceries").
 * @returns The id of the deleted category.
 * @throws If the response status is not OK (e.g. 404 when the id is unknown).
 */
export async function deleteCategory(id: string): Promise<{ id: string }> {
  const response = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await buildHeaders(),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/** A budget's target plus its computed spend for the current window. */
export interface BudgetRollup {
  target: number;
  posted: number;   // settled (posted) spend
  pending: number;  // not-yet-settled (pending) spend
}

/**
 * Fetch every budgeted category's target plus its computed posted/pending spend
 * for the current window. Empty {} before any target is set.
 *
 * @param days - The client's pay-cycle length. The server derives the window from the
 *   stored pay cycle and ignores this (WHIT-72); kept for symmetry with fetchBreakdown.
 * @returns A map of category id to its { target, posted, pending }.
 * @throws If the response status is not OK.
 */
export async function fetchBudgets(days: number): Promise<Record<string, BudgetRollup>> {
  const response = await fetch(`${API_BASE}/budgets?days=${encodeURIComponent(days)}`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/** A category's computed spend for the current pay cycle. */
export interface CategorySpend {
  posted: number;   // settled (posted) spend
  pending: number;  // not-yet-settled (pending) spend
}

/**
 * Fetch spend by category for the current pay cycle (WHIT-23) — every category
 * with spend this cycle, plus the special "__uncategorized__" bucket for spend
 * that counts to budget but isn't in the taxonomy. Empty {} when nothing had spend.
 *
 * @param days - The client's pay-cycle length. The server derives the window from
 *   the stored pay cycle and ignores this; kept for symmetry with fetchBudgets.
 * @returns A map of category id to its { posted, pending }.
 * @throws If the response status is not OK.
 */
export async function fetchBreakdown(days: number): Promise<Record<string, CategorySpend>> {
  const response = await fetch(`${API_BASE}/breakdown?days=${encodeURIComponent(days)}`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Set (persist) a single transaction's category.
 *
 * @param id - The transaction_id to categorise.
 * @param category - The category id/slug to file it under.
 * @returns The transaction_id and the category that was saved.
 * @throws If the response status is not OK (e.g. 404 when the id is unknown).
 */
export async function setTransactionCategory(
  id: string,
  category: string
): Promise<{ transaction_id: string; category: string }> {
  const response = await fetch(`${API_BASE}/transactions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ category }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/** One transaction's outcome in a batch category update (WHIT-70). */
export interface BatchCategoryResult {
  id: string;
  status: "updated" | "not_found";
}

/**
 * Set the category on many transactions in ONE request (WHIT-70) — the batch
 * behind "All from this merchant", replacing N parallel single PATCHes. Each
 * update is applied independently server-side; the returned `results` carry a
 * per-item status (keyed by `id`, not position) so the caller can roll back only
 * the ones that didn't land. Auth-gated like every app route (WHIT-110).
 *
 * @throws If the response status is not OK.
 */
export async function setTransactionCategories(
  updates: { id: string; category: string }[]
): Promise<{ results: BatchCategoryResult[] }> {
  const response = await fetch(`${API_BASE}/transactions`, {
    method: "PATCH",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ updates }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * The live home-loan balance (WHIT-8). `balance` is the outstanding mortgage
 * principal as a positive number; all three fields are null before the balance
 * poller's first run has stored a value.
 */
export interface HomeLoan {
  balance: number | null;
  as_of: string | null;   // ISO timestamp BankSync reported the balance
  currency: string | null;
}

/**
 * Fetch the latest live home-loan balance. Returns a null-filled shape (not an
 * error) before the poller has stored anything, so the caller can simply keep
 * its placeholder until a real balance lands.
 *
 * @returns The stored { balance, as_of, currency } (balance null if unpolled).
 * @throws If the response status is not OK.
 */
export async function fetchHomeLoan(): Promise<HomeLoan> {
  const response = await fetch(`${API_BASE}/homeloan`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * One account's live balance (WHIT-212), as served by GET /accounts/balances. `amount`
 * is SIGNED — a spending account is positive, a loan or credit-card balance negative —
 * matching what the bank reports. `available_balance`/`account_type` are null when the
 * bank didn't report them; `as_of` is the ISO timestamp BankSync read the balance.
 */
export interface AccountBalance {
  account_id: string;
  amount: number;
  available_balance: number | null;
  currency: string;
  as_of: string;
  account_type: string | null;
}

/**
 * Fetch the latest live balance for each linked account. Poller-fed, like the home-loan
 * balance: an account not yet polled is simply absent, and before ANY poll this is an
 * empty array — a normal success, not an error — so the caller shows a "—" placeholder
 * per card rather than an error state.
 *
 * @throws If the response status is not OK.
 */
export async function fetchAccountBalances(): Promise<AccountBalance[]> {
  const response = await fetch(`${API_BASE}/accounts/balances`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * The most recent home-loan repayment (WHIT-115), derived server-side from the
 * up-homeloan transaction history. `amount`/`date` are null when there is no
 * repayment on record; `principal`/`interest` are null when the interest leg
 * can't be paired (total-only — never a fabricated split).
 */
export interface Repayment {
  amount: number | null;
  date: string | null;       // ISO "YYYY-MM-DD"
  principal: number | null;
  interest: number | null;
}

/**
 * Fetch the latest home-loan repayment. Returns a null-filled shape (not an
 * error) when none is on record, so the caller shows a graceful empty state.
 *
 * @throws If the response status is not OK.
 */
export async function fetchRepayment(): Promise<Repayment> {
  const response = await fetch(`${API_BASE}/repayment`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * The user-entered home-loan facts no bank feed provides (Loan facts card).
 * Every field is null until the user saves the form the first time — the app
 * shows a friendly "set this up" state rather than fabricating defaults.
 */
export interface LoanFacts {
  original: number | null;   // original loan amount
  homeValue: number | null;  // current property value
  lvr: number | null;        // loan-to-value ratio, a fraction 0–1
  ratePct: number | null;    // interest rate, a percent
  baseRepay: number | null;  // scheduled repayment per cycle
  extra: number | null;      // extra repayment per cycle
  // WHIT-126: target payoff date, ISO "YYYY-MM-DD". Independently OPTIONAL — unlike
  // the six all-or-nothing facts above, it's null/absent until the user sets one, and
  // drives the required-repayment solver on the "won't pay off" state.
  payoffGoalDate?: string | null;
}

/**
 * The saved shape the form PUTs. The six numeric facts are always present; the
 * optional payoff goal date rides alongside them (null/absent when unset/cleared).
 */
export interface LoanFactsInput {
  original: number; homeValue: number; lvr: number; ratePct: number; baseRepay: number; extra: number;
  payoffGoalDate?: string | null;
}

/**
 * Fetch the user's saved loan facts. Returns all-null fields until the user has
 * saved them (so the caller shows a set-up prompt), never an error for "unset".
 *
 * @throws If the response status is not OK.
 */
export async function fetchLoanFacts(): Promise<LoanFacts> {
  const response = await fetch(`${API_BASE}/loanfacts`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Save (replace) the user's loan facts — all six fields together.
 *
 * @param facts - The full { original, homeValue, lvr (fraction), ratePct, baseRepay, extra }.
 * @returns The saved facts.
 * @throws If the response status is not OK (e.g. 400 on an invalid field).
 */
export async function setLoanFacts(facts: LoanFactsInput): Promise<LoanFactsInput> {
  const response = await fetch(`${API_BASE}/loanfacts`, {
    method: "PUT",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(facts),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/** The persisted pay cycle: window length in days + the last pay date. */
export interface PayCycle {
  length: number;        // 7 | 14 | 30 (Weekly / Fortnightly / Monthly)
  last_pay_date: string;        // a real past payday, as an ISO "YYYY-MM-DD" date
}

/**
 * Fetch the persisted pay cycle (length + last pay date). Seeds a default
 * server-side on first read, so this always resolves to a valid cycle.
 *
 * @returns The stored { length, last_pay_date }.
 * @throws If the response status is not OK.
 */
export async function fetchPayCycle(): Promise<PayCycle> {
  const response = await fetch(`${API_BASE}/paycycle`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Set (replace) the persisted pay cycle. Both fields are written together, so
 * pass the full cycle even when only one field changed.
 *
 * @param cycle - The new { length, last_pay_date }. last_pay_date must be a past ISO date.
 * @returns The saved { length, last_pay_date }.
 * @throws If the response status is not OK (e.g. 400 on a bad length or a
 *   future/malformed last_pay_date).
 */
export async function setPayCycle(cycle: PayCycle): Promise<PayCycle> {
  const response = await fetch(`${API_BASE}/paycycle`, {
    method: "PUT",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(cycle),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Set (upsert) a category's budget target. Idempotent — works whether or not
 * the category already had a target.
 *
 * @param categoryId - The category id/slug to budget (e.g. "groceries").
 * @param target - The pay-cycle target amount (must be >= 0).
 * @returns The saved id and target.
 * @throws If the response status is not OK (e.g. 400 on an invalid target).
 */
export async function setBudget(
  categoryId: string,
  target: number
): Promise<{ id: string; target: number }> {
  const response = await fetch(`${API_BASE}/budgets/${encodeURIComponent(categoryId)}`, {
    method: "PUT",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ target }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * List every categorisation rule from the enrichments API. Auth-gated.
 *
 * @returns The rules currently held by BankSync (source of truth).
 * @throws If the response status is not OK (401 when the token is wrong/missing).
 */
export async function listEnrichments(): Promise<EnrichmentRule[]> {
  const response = await fetch(`${API_BASE}/enrichments`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Create a categorisation rule. `field`/`operator` are omitted by default so the
 * server applies its "description contains" default — matching what the app's
 * rule UI produces. Auth-gated.
 *
 * @param input - `{value, categoryId}` (+ optional `field`/`operator`).
 * @returns The created rule, including its BankSync-assigned id.
 * @throws If the response status is not OK (400 on an invalid rule, 401 on auth).
 */
export async function createEnrichment(
  input: { value: string; categoryId: string; field?: string; operator?: string }
): Promise<EnrichmentRule> {
  const response = await fetch(`${API_BASE}/enrichments`, {
    method: "POST",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Update (replace) a categorisation rule. `field`/`operator` are omitted by
 * default so the server keeps its "description contains" default. Auth-gated.
 *
 * @param id - The BankSync enrichment id to update.
 * @param input - `{value, categoryId}` (+ optional `field`/`operator`).
 * @returns The updated rule.
 * @throws If the response status is not OK (404 unknown id, 400 invalid, 401 auth).
 */
export async function updateEnrichment(
  id: string,
  input: { value: string; categoryId: string; field?: string; operator?: string }
): Promise<EnrichmentRule> {
  const response = await fetch(`${API_BASE}/enrichments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Delete a categorisation rule. Idempotent server-side (an unknown id still
 * returns 200). Auth-gated.
 *
 * @param id - The BankSync enrichment id to remove.
 * @returns The id of the deleted rule.
 * @throws If the response status is not OK (401 on auth).
 */
export async function deleteEnrichment(id: string): Promise<{ id: string }> {
  const response = await fetch(`${API_BASE}/enrichments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: await buildHeaders(),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * AI spending insights (WHIT-104): a short summary + a few suggestions grounded in
 * the user's real spend. `summary` is null before any have been generated this
 * cycle. `cached` is true when the server returned a stored result without paying
 * for a fresh generation.
 */
export interface AiInsights {
  summary: string | null;
  suggestions: string[];
  generated_at: string | null;
  cycle_start: string | null;
  cached: boolean;
}

/**
 * Home-loan goal signal sent with a generate request (WHIT-134) so the advice can
 * tie spend cuts to becoming mortgage-free sooner. Derived on-device from WHIT-114's
 * payoff projection (the single source of truth — the server does NOT recompute the
 * amortization). Only sent when there's an honest payoff signal; null otherwise.
 *
 * Two shapes, discriminated on payoff_mode:
 *
 * On-track ('partial' | 'flat' | 'ahead') — the loan DOES clear:
 * - mortgage_free_date: the projected month-year, e.g. "Nov 2042".
 * - current_extra_monthly: extra $/month currently paid on top of the scheduled repayment.
 * - months_sooner_per_100_extra: months the payoff moves in for each additional
 *   $100/month (exact, from the same amortization). null when it rounds to < 1 month.
 *
 * Shortfall ('shortfall') — the loan will NOT clear at the current repayment, but
 * the user has set a target payoff date (WHIT-126):
 * - goal_date: the target month-year label, e.g. "Nov 2030" (matches mortgage_free_date's format).
 * - required_repayment: the $/month needed to clear the loan by goal_date.
 * - required_extra: how much more than the current total repayment that is, per month.
 * - current_extra_monthly: extra $/month currently paid on top of the scheduled repayment.
 */
export type AiGoalSignal =
  | {
      payoff_mode: 'partial' | 'flat' | 'ahead';
      mortgage_free_date: string;
      current_extra_monthly: number;
      months_sooner_per_100_extra: number | null;
    }
  | {
      payoff_mode: 'shortfall';
      goal_date: string;
      required_repayment: number;
      required_extra: number;
      current_extra_monthly: number;
    };

/**
 * Read the cached AI insights for the current pay cycle WITHOUT generating (no
 * paid call). Returns a null-summary shape when none has been generated yet.
 * Auth-gated (the endpoint costs money, so it sits behind the token like
 * /enrichments).
 *
 * @throws If the response status is not OK (401 on auth).
 */
export async function fetchAiInsights(): Promise<AiInsights> {
  const response = await fetch(`${API_BASE}/insights/ai`, { headers: await buildHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Generate (or return the cached) AI insights for the current cycle — the paid
 * action behind the "Analyse my spending" button. The server skips the paid call
 * when nothing has changed since the cached run. Auth-gated.
 *
 * When a `goal` is supplied it's sent in the body so the advice can tie cuts to the
 * mortgage-free date (WHIT-134). The signal is part of what the server hashes for its
 * per-cycle cache, so a changed goal regenerates. Sending `{goal: null}` keeps the
 * body shape stable and is treated exactly like the spend-only request.
 *
 * @throws If the response status is not OK (401 auth, 502 when the AI is unavailable).
 */
export async function generateAiInsights(goal?: AiGoalSignal | null): Promise<AiInsights> {
  const response = await fetch(`${API_BASE}/insights/ai`, {
    method: "POST",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ goal: goal ?? null }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Register this device's Expo push token so the server can send it notifications.
 * Auth-gated (the /devices route is behind the Cognito JWT authorizer, like every
 * app route), so it presents the Bearer ID token like the other calls. The server
 * stores tokens in a Set, so re-registering the same token is a no-op.
 *
 * @param token - The device's `ExpoPushToken[...]` value.
 * @returns The registered token, echoed by the server.
 * @throws If the response status is not OK (400 invalid token, 401 auth).
 */
export async function registerDevice(token: string): Promise<{ token: string }> {
  const response = await fetch(`${API_BASE}/devices`, {
    method: "POST",
    headers: await buildHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ token }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}
