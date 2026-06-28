import { Transaction } from "./context";
const API_BASE = "https://mx38xevtll.execute-api.ap-southeast-2.amazonaws.com";
export async function fetchTransactions(): Promise<Transaction[]> {
  const response = await fetch(`${API_BASE}/transactions`);
  if (response.ok == false) throw new Error(`API error: ${response.status}`);

  return response.json();
}
