// WHIT-685 — fill the fake server with Goals / mortgage / milestone data from the app-shaped values
// the old makeGoalData fakes used, so the real screen data code (../queries) runs. Usage in a suite
// (the jest.mock calls must stay in the test file, for hoisting):
//
//   jest.mock('../auth', () => require('./support/authMock').authMockModule());
//   jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule());
//   const server = installFakeServer();
//   useTestQueryClient();
//   beforeEach(() => resetAuth());
//   seedGoal(server, { homeLoan: { balance: 250000, asOf: '2026-07-04T00:00:00Z' }, milestones: [] });
//   await renderWithQueries(<Mortgage />);
//
// (Not a *.test file, so the jest testMatch never runs it as a suite.)
import { jest } from '@jest/globals';
import type { installFakeServer } from './fakeServer';
import { realContextWith } from './contextMock';
import type { GoalRecord, LoanFacts, MilestoneRecord, PayCycle, Repayment } from '../../api';
import type { HomeLoanState } from '../../model';
import { DEFAULT_MILESTONES, EMPTY_LOAN_FACTS, LOAN_FACTS, NO_REPAYMENT } from '../factory';

type FakeServer = ReturnType<typeof installFakeServer>;

const AS_OF = '2026-07-04T00:00:00Z';

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

export interface GoalsHubSeed {
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

// The Goals-tab suites' shared world: a fortnightly cycle (paydays …Jul4, Jul18, Aug1, Aug15),
// $4,000 in up-spending, no loan facts yet, and a home loan owing $596,642.43.
export const GOALS_HUB_CYCLE: PayCycle = { length: 14, last_pay_date: '2026-06-06' };
const GOALS_HUB_DEFAULTS: GoalsHubSeed = {
  payCycle: GOALS_HUB_CYCLE,
  balances: { 'up-spending': 4000 },
  loanFacts: EMPTY_LOAN_FACTS,
  homeLoan: { balance: 596642.43, asOf: AS_OF },
};

/** seedGoalsHub over GOALS_HUB_DEFAULTS — pass only what the test changes. */
export function seedHubWith(server: FakeServer, over: GoalsHubSeed = {}) {
  seedGoalsHub(server, { ...GOALS_HUB_DEFAULTS, ...over });
}

/** The celebration suites' hub: these goals and balances, no loan facts, and the home loan owing `homeLoanBalance`. */
export function seedCelebrationHub(
  server: FakeServer, goals: GoalRecord[], balances: Record<string, number>, homeLoanBalance: number | null = null,
) {
  seedGoalsHub(server, {
    goals, payCycle: GOALS_HUB_CYCLE, balances, loanFacts: EMPTY_LOAN_FACTS, homeLoan: { balance: homeLoanBalance, asOf: AS_OF },
  });
}

// The Goals screens call useAppContext only for openGoalBalance; the rest of ../context stays real
// (balanceGoalView etc.). Pass a getter, not the fn: jest.mock factories run before the suite's consts.
export function goalsContextMockModule(openGoalBalance: () => unknown = () => jest.fn()) {
  return realContextWith(() => ({ openGoalBalance: openGoalBalance() }));
}
