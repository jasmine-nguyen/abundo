// WHIT-652 QA — adversarial checks on the fake server's sent / sentUnder, driven through the
// REAL src/api.ts calls: the log they read resets per test, sent never prefix-matches, and
// sentUnder('/rules') catches both /rules and /rules/:id (ruleWriterRecursionGuard relies on it).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { resetAuth } from './authMock';
import { installFakeServer } from './fakeServer';

const COLES = { value: 'COLES', categoryId: 'groceries' };

beforeEach(() => resetAuth());

describe('WHIT-652 QA fake server sent / sentUnder', () => {
  const server = installFakeServer();

  // [A1] a request sent in one test is not counted in the next
  it('[A1a] sends a rule write', async () => {
    await api.createRule(COLES);
    expect(server.sent('POST', '/rules')).toHaveLength(1);
  });

  it('[A1b] starts the next test with nothing sent', () => {
    expect(server.sent('POST', '/rules')).toEqual([]);
    expect(server.sentUnder('POST', '/')).toEqual([]);
  });

  // [A2] sent is exact: a parent path never matches a child path
  it('[A2] sent does not treat its path as a prefix', async () => {
    server.seed('/rules', [{ id: 'e1', ...COLES }]);
    await api.updateRule('e1', COLES);
    await api.deleteRule('e1');

    expect(server.sent('PUT', '/rules')).toEqual([]);
    expect(server.sent('DELETE', '/rules')).toEqual([]);
    expect(server.sent('PUT', '/rules/e1')).toEqual([{ method: 'PUT', path: '/rules/e1', body: COLES }]);
  });

  // [A3] sentUnder('/rules') catches the collection path and every item path, per method, in order
  it('[A3] sentUnder matches the prefix itself and paths below it, filtered by method', async () => {
    server.seed('/rules', [{ id: 'e1', ...COLES }]);
    await api.createRule(COLES);
    await api.updateRule('e1', COLES);
    await api.listRules();
    await api.updateRule('e1', { ...COLES, categoryId: 'dining' });

    expect(server.sentUnder('POST', '/rules')).toEqual([{ method: 'POST', path: '/rules', body: COLES }]);
    expect(server.sentUnder('PUT', '/rules').map((request) => request.body)).toEqual([
      COLES,
      { ...COLES, categoryId: 'dining' },
    ]);
    expect(server.sentUnder('GET', '/rules')).toHaveLength(1);
  });
});
