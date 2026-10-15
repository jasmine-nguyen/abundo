// A saved account balance as GET /accounts/balances returns it. (Not a *.test file, so Jest never runs it.)
import type { AccountBalance } from '../../api';

export const accountBalance = (over: Partial<AccountBalance> = {}): AccountBalance => ({
  account_id: 'a1', amount: 100, available_balance: 100, currency: 'AUD',
  as_of: '2026-07-08T09:32:02.405Z', account_type: 'checking', ...over,
});
