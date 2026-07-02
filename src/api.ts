import { Transaction, Cat, Bucket } from "./context";
const API_BASE = "https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com";

export async function fetchTransactions(): Promise<Transaction[]> {
  const response = await fetch(`${API_BASE}/transactions`);
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

export async function fetchCategories(): Promise<Cat[]> {
  const response = await fetch(`${API_BASE}/categories`);
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

export async function createCategory(
  input: { name: string; bucket: Bucket; icon: string }
): Promise<Cat> {
  const response = await fetch(`${API_BASE}/categories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

export async function updateCategory(
  id: string,
  input: { name: string; bucket: Bucket; icon: string }
): Promise<Cat> {
  const response = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}

export async function deleteCategory(id: string): Promise<{ id: string }> {
  const response = await fetch(`${API_BASE}/categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}
