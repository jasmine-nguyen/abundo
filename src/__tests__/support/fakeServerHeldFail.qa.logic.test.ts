// WHIT-659 QA — held.fail(method, reply) edges the swapped suites rely on, driven through the REAL src/api.ts.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';

const PLAN = [{ id: 'c', label: 'Client-minted', target: 1 }] as never;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => resetAuth());

describe('WHIT-659 QA — held.fail', () => {
  const server = installFakeServer();

  // [A1] (P0) the failure is scoped to the method: another method held on the same path still succeeds.
  it('[A1] fails only the named method; a PUT held on the same path answers normally', async () => {
    server.seed('/goals', [{ id: 'g1', target: 100 }]);
    const held = server.hold('/goals/g1');
    const save = api.saveGoal('g1', { target: 200 } as never).then(() => 'resolved', (e: unknown) => e);
    const remove = api.deleteGoal('g1').then(() => 'resolved', (e: unknown) => e);
    await flush();

    held.fail('DELETE', { status: 500 });

    expect(await save).toBe('resolved');
    expect(await remove).toMatchObject({ message: 'API error: 500' });
  });

  // [A2] (P1) one fail() = one failed reply: a second held call of the same method gets the normal answer.
  it('[A2] with two same-method calls held, only the first fails', async () => {
    const held = server.hold('/milestones');
    const first = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    const second = api.setMilestones(PLAN).then(() => 'resolved', (e: unknown) => e);
    await flush();
    expect(server.sent('PUT', '/milestones')).toHaveLength(2);

    held.fail('PUT');

    expect(await first).toBeInstanceOf(TypeError);
    expect(await second).toBe('resolved');
  });
});
