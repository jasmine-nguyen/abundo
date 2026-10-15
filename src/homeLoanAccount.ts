import type { AccountBalance } from './api';
import { goalView, milestoneView } from './context';
import type { GoalViewInput } from './context';

// ABU-64: BankSync reports the home loan's balance with accountType "mortgage".
const HOME_LOAN_ACCOUNT_TYPE = 'mortgage';

export function isHomeLoanAccount(balance: AccountBalance | null | undefined): boolean {
  return balance?.account_type === HOME_LOAN_ACCOUNT_TYPE;
}

// The Accounts-list subtitle for the home loan, from the same maths as the Home loan screen.
// null when there's no plan or paydown to show.
export function homeLoanProgressLine(s: GoalViewInput): string | null {
  const m = milestoneView(s);
  if (m.hasBalance && m.nextMilestone) return `Next milestone: ${m.amountToNextLabel} to go`;
  if (m.hasBalance && m.hasPlan) return 'Target reached';
  const g = goalView(s);
  if (g.paidDownReady) return `${g.paidPctLabel}% paid off`;
  return null;
}
