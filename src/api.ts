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
