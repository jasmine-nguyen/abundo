// The delete-category setup the deleteCategoryOptimistic and transactionCache tests seed (WHIT-628, shared by WHIT-719):
// two categories, a rule and a budget for each, and the charges filed under them.
import type { Transaction, Category } from '../../types';
import type { Rule } from '../../model';

export const DELETE_DINING = { id: 'dining', name: 'Dining', bucket: 'Living', icon: 'food', color: '#f00', recent: 0, parent: null } satisfies Category;
export const DELETE_GROCERIES = { id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#0f0', recent: 0, parent: null } satisfies Category;
export const DELETE_DINING_RULE: Rule = { id: 'r1', pattern: 'COLES', categoryId: 'dining', isNew: false };
export const DELETE_GROCERIES_RULE: Rule = { id: 'r2', pattern: 'WOOLIES', categoryId: 'groceries', isNew: false };
export const DELETE_DINING_BUDGET = { target: 200, posted: 12.5, pending: 0 };
export const DELETE_GROCERIES_BUDGET = { target: 300, posted: 0, pending: 0 };

export const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  transaction_id: id, date: '2026-07-01', authorized_date: '2026-07-01',
  description: 'COLES 0412 SYDNEY', merchant_name: 'Coles', amount: -12.5, account_id: 'a1',
  account_name: 'ANZ', category: 'dining', status: 'posted', type: 'PAYMENT', counts_to_budget: true, ...over,
});
export const page = (transactions: Transaction[]) => ({ pages: [{ transactions, nextCursor: null }], pageParams: [undefined] });
