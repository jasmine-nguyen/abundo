import { Transaction, Category, Bucket } from "./context";
const API_BASE = "https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com";

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

/**
 * Fetch all persisted budget targets as a { categoryId: target } map. Empty
 * before any target is set. `posted`/`pending` are not part of this endpoint.
 *
 * @returns A map of category id to its budget-target number.
 * @throws If the response status is not OK.
 */
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

export async function fetchBudgets(): Promise<Record<string, number>> {
  const response = await fetch(`${API_BASE}/budgets`);
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
