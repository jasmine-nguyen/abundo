import { Transaction, Category, Bucket } from "./context";
const API_BASE = "https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com";

/**
 * The shared-secret token the app presents to the auth-gated /enrichments routes
 * (the only gated endpoints — every other call here is open).
 *
 * Read at CALL time, not as a module const: the Expo bundler rewrites
 * `process.env.EXPO_PUBLIC_API_TOKEN` to read from a live env reference, so a
 * module-level capture would freeze an early/undefined value (and break tests
 * that set the var before calling). Throws loudly if unset — better a clear
 * error than silently sending `Bearer undefined` and getting a 401 on every
 * rule action. EXPO_PUBLIC_API_TOKEN must be set at build/export time.
 */
function apiToken(): string {
  const token = process.env.EXPO_PUBLIC_API_TOKEN;
  if (!token) {
    throw new Error("Missing EXPO_PUBLIC_API_TOKEN");
  }
  return token;
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${apiToken()}` };
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
  const response = await fetch(`${API_BASE}/transactions`);
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
  const response = await fetch(`${API_BASE}/categories`);
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
 * @param days - Rolling window length (the client's pay-cycle length); the server
 *   sums spend over the last `days` days.
 * @returns A map of category id to its { target, posted, pending }.
 * @throws If the response status is not OK.
 */
export async function fetchBudgets(days: number): Promise<Record<string, BudgetRollup>> {
  const response = await fetch(`${API_BASE}/budgets?days=${encodeURIComponent(days)}`);
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
  const response = await fetch(`${API_BASE}/breakdown?days=${encodeURIComponent(days)}`);
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
    headers: { "Content-Type": "application/json" },
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
 * the ones that didn't land. Open route, like the single PATCH — no auth header.
 *
 * @throws If the response status is not OK.
 */
export async function setTransactionCategories(
  updates: { id: string; category: string }[]
): Promise<{ results: BatchCategoryResult[] }> {
  const response = await fetch(`${API_BASE}/transactions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
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
  const response = await fetch(`${API_BASE}/homeloan`);
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
  const response = await fetch(`${API_BASE}/repayment`);
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
}

/** The saved shape — all six fields present (what the form PUTs). */
export interface LoanFactsInput {
  original: number; homeValue: number; lvr: number; ratePct: number; baseRepay: number; extra: number;
}

/**
 * Fetch the user's saved loan facts. Returns all-null fields until the user has
 * saved them (so the caller shows a set-up prompt), never an error for "unset".
 *
 * @throws If the response status is not OK.
 */
export async function fetchLoanFacts(): Promise<LoanFacts> {
  const response = await fetch(`${API_BASE}/loanfacts`);
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
    headers: { "Content-Type": "application/json" },
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
  const response = await fetch(`${API_BASE}/paycycle`);
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
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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
  const response = await fetch(`${API_BASE}/enrichments`, { headers: authHeaders() });
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
    headers: authHeaders(),
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
 * Read the cached AI insights for the current pay cycle WITHOUT generating (no
 * paid call). Returns a null-summary shape when none has been generated yet.
 * Auth-gated (the endpoint costs money, so it sits behind the token like
 * /enrichments).
 *
 * @throws If the response status is not OK (401 on auth).
 */
export async function fetchAiInsights(): Promise<AiInsights> {
  const response = await fetch(`${API_BASE}/insights/ai`, { headers: authHeaders() });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Generate (or return the cached) AI insights for the current cycle — the paid
 * action behind the "Analyse my spending" button. The server skips the paid call
 * when nothing has changed since the cached run. Auth-gated.
 *
 * @throws If the response status is not OK (401 auth, 502 when the AI is unavailable).
 */
export async function generateAiInsights(): Promise<AiInsights> {
  const response = await fetch(`${API_BASE}/insights/ai`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

/**
 * Register this device's Expo push token so the server can send it notifications.
 * Auth-gated (the /devices route sits behind the same shared-secret authorizer as
 * /enrichments), so it presents the Bearer token like the enrichments calls. The
 * server stores tokens in a Set, so re-registering the same token is a no-op.
 *
 * @param token - The device's `ExpoPushToken[...]` value.
 * @returns The registered token, echoed by the server.
 * @throws If the response status is not OK (400 invalid token, 401 auth).
 */
export async function registerDevice(token: string): Promise<{ token: string }> {
  const response = await fetch(`${API_BASE}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ token }),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}
