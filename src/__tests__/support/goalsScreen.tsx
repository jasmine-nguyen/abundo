// WHIT-685 — fill the fake server with Goals / mortgage / milestone data from the app-shaped values
// the old makeGoalData fakes used, so the real screen data code (../queries) runs. Usage in a suite
// (the jest.mock calls must stay in the test file, for hoisting):
//
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   const server = installFakeServer();
//   useTestQueryClient();
//   beforeEach(() => resetAuth());
//   seedGoal(server, { homeLoan: { balance: 250000, asOf: '2026-07-04T00:00:00Z' }, milestones: [] });
//   await renderWithQueries(<Mortgage />);
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { jest } from '@jest/globals';
import type { installFakeServer } from './fakeServer';
import type { GoalRecord, LoanFacts, MilestoneRecord, PayCycle, Repayment } from '../../api';
import type { HomeLoanState } from '../../model';
import { DEFAULT_MILESTONES, LOAN_FACTS, NO_REPAYMENT } from '../factory';

type FakeServer = ReturnType<typeof installFakeServer>;

const AS_OF = '2026-07-04T00:00:00Z';

/** Pin today's date only. Timers stay real, so the fake server's replies and waitFor still settle. */
export function pinToday(now: Date) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
      'nextTick', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'hrtime', 'performance',
    ],
  });
}

function seedHomeLoan(server: FakeServer, homeLoan: HomeLoanState) {
  server.seed('/homeloan', { balance: homeLoan.balance, as_of: homeLoan.asOf, currency: 'AUD' });
}

interface GoalSeed {
  loanFacts?: LoanFacts;
  homeLoan?: HomeLoanState;
  repayment?: Repayment;
  milestones?: MilestoneRecord[];
}

/** The mortgage / milestone screens' reads. Defaults match makeGoalData. */
export function seedGoal(
  server: FakeServer,
  { loanFacts = LOAN_FACTS, homeLoan = { balance: null, asOf: null }, repayment = NO_REPAYMENT, milestones = DEFAULT_MILESTONES }: GoalSeed = {},
) {
  server.seed('/loanfacts', loanFacts);
  seedHomeLoan(server, homeLoan);
  server.seed('/repayment', repayment);
  server.seed('/milestones', milestones);
}

interface GoalsHubSeed {
  goals?: GoalRecord[];
  payCycle?: PayCycle;
  balances?: Record<string, number>;
  loanFacts?: LoanFacts;
  homeLoan?: HomeLoanState;
}

/** The Goals tab's reads. `balances` is the old balanceFor lookup: account id → live balance. */
export function seedGoalsHub(
  server: FakeServer,
  { goals = [], payCycle, balances = {}, loanFacts = LOAN_FACTS, homeLoan = { balance: null, asOf: null } }: GoalsHubSeed = {},
) {
  server.seed('/goals', goals);
  if (payCycle) server.seed('/paycycle', payCycle);
  server.seed('/accounts/balances', Object.entries(balances).map(([accountId, amount]) => ({
    account_id: accountId, amount, available_balance: null, currency: 'AUD', as_of: AS_OF, account_type: null,
  })));
  server.seed('/loanfacts', loanFacts);
  seedHomeLoan(server, homeLoan);
}
