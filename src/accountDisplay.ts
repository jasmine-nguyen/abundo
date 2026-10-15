// ABU-65: every per-account display rule, shared by the Accounts tab and the account detail screen.
import type { AccountBalance } from './api';
import type { AccountSummary } from './context';
import { dateLabel } from './context';
import { isHomeLoanAccount } from './homeLoanAccount';
import { C, fmt, fmtBalance, ACCOUNT_ACCENTS } from './theme';

export type AccountKind = 'card' | 'everyday' | 'loan' | 'unknown';

// BankSync reports credit cards as accountType "unknown", so anything not a mortgage or checking
// account counts as a card.
export function accountKind(bal?: AccountBalance): AccountKind {
  if (!bal) return 'unknown';
  if (isHomeLoanAccount(bal)) return 'loan';
  if (bal.account_type === 'checking') return 'everyday';
  return 'card';
}

export const ACCOUNT_KIND_ICON: Record<AccountKind, string> = { card: 'card', everyday: 'wallet', loan: 'home', unknown: 'bank' };

const KIND_RANK: Record<AccountKind, number> = { card: 0, everyday: 1, loan: 2, unknown: 3 };

export function orderAccounts(summaries: AccountSummary[], balances: Map<string, AccountBalance>): AccountSummary[] {
  const rank = (a: AccountSummary) => KIND_RANK[accountKind(balances.get(a.id))];
  return [...summaries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ponytail: a 4-colour hash can give two future accounts the same colour; cosmetic only.
export function accountAccent(id: string): string {
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCOUNT_ACCENTS[x % ACCOUNT_ACCENTS.length];
}

// Credit left on a credit card: you owe (amount < 0) yet can still draw (available > 0). This
// excludes the loan (available 0) and a spending account (positive amount).
export function availableCredit(bal?: AccountBalance): number | null {
  if (!bal || bal.amount >= 0 || bal.available_balance == null || bal.available_balance <= 0) return null;
  return bal.available_balance;
}

// Owing money is normal (a card, the mortgage), so it reads in bright neutral text with an "owed"
// label instead of alarm rose; money in stays C.good.
export function balanceDisplay(amount: number): { text: string; color: string; owed: boolean } {
  if (amount < 0) return { text: fmtBalance(Math.abs(amount)), color: C.textBright, owed: true };
  return { text: fmtBalance(amount), color: C.good, owed: false };
}

export function accountSubtitle({ summary, bal, loanLine }: { summary: AccountSummary; bal?: AccountBalance; loanLine: string | null }): string {
  if (isHomeLoanAccount(bal)) return loanLine ?? 'Home loan · payoff inside';
  const credit = availableCredit(bal);
  if (credit !== null) return `${fmt(credit)} available`;
  if (!summary.lastSpendDate) return 'No recent spending';
  const label = dateLabel(summary.lastSpendDate);
  if (label === 'Today' || label === 'Yesterday') return `Last spend ${label.toLowerCase()}`;
  return `Last spend ${label}`;
}
