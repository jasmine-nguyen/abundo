// WHIT-630: the base data shapes, in a leaf file with no imports so api.ts, queries.ts and the
// store can all depend on them without importing each other in a loop.
export type Bucket = 'Living' | 'Lifestyle' | 'Income' | 'Savings';

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  bucket: Bucket;
  // Id of the parent this category rolls up into; null (or absent) means
  // top-level. Optional so existing category literals stay valid; toCategory
  // always normalises it to a value.
  parent?: string | null;
  // The server's permanent chart-colour slot, an integer in [0,20). Optional so existing
  // category literals — and a server that predates slots — stay valid; absent means the
  // Insights chart falls back to the id-derived colour.
  colorSlot?: number;
}
export interface Transaction {
  transaction_id: string;
  date: string;            // "YYYY-MM-DD"
  authorized_date: string;
  description: string;
  merchant_name: string;
  amount: number;
  account_id: string;
  account_name: string;
  category: string | null;
  status: 'pending' | 'posted';
  type: string;
  counts_to_budget: boolean;
  // WHIT-275: user-authored, optional. Absent when never set or cleared (the
  // server REMOVEs a cleared field, so it reads back undefined, not ""/[]).
  notes?: string;
  tags?: string[];
  // WHIT-296: user override to exclude this transaction from budgets ("mark as
  // transfer"). Absent (undefined) = not excluded; only True is stored server-side.
  budget_excluded?: boolean;
  // WHIT-536/539: the store id of the rule that auto-filed this charge's category.
  // Server-stamped, sparse — absent when filed by hand or by the bank. The detail
  // screen resolves it against the rules cache to explain the category (WHIT-539).
  filed_by_rule?: string;
}
