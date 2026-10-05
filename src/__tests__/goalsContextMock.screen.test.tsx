// WHIT-752 — the shared Goals-screen fake for ../context (support/goalsScreen goalsContextMockModule).
// A suite mocks ../context with it: useAppContext hands back only an openGoalBalance fake, and every
// other export (balanceGoalView etc.) stays the real one so the Goals engine still runs.
import { describe, it, expect, jest } from '@jest/globals';
import { balanceGoalView, paydaysUntil, useAppContext } from '../context';

const mockOpenGoalBalance = jest.fn();
jest.mock('../context', () => require('./support/goalsScreen').goalsContextMockModule(() => mockOpenGoalBalance));

type ContextModule = typeof import('../context');

describe('the shared Goals-screen context fake', () => {
  it('a suite that mocks ../context with it gets its own openGoalBalance and the real Goals engine', () => {
    const actual = jest.requireActual('../context') as ContextModule;

    expect(useAppContext()).toEqual({ openGoalBalance: mockOpenGoalBalance });
    expect(useAppContext().openGoalBalance).toBe(mockOpenGoalBalance);
    expect(balanceGoalView).toBe(actual.balanceGoalView);
    expect(paydaysUntil).toBe(actual.paydaysUntil);
  });

  it('with no argument, useAppContext hands back a plain jest fake for openGoalBalance', () => {
    const { goalsContextMockModule } = require('./support/goalsScreen') as {
      goalsContextMockModule: (openGoalBalance?: () => unknown) => ContextModule;
    };
    const actual = jest.requireActual('../context') as ContextModule;
    const fake = goalsContextMockModule();

    const context = fake.useAppContext() as unknown as Record<string, unknown>;
    expect(Object.keys(context)).toEqual(['openGoalBalance']);
    expect(jest.isMockFunction(context.openGoalBalance)).toBe(true);
    expect(fake.balanceGoalView).toBe(actual.balanceGoalView);
  });
});
