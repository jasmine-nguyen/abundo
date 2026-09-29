// WHIT-639 — a reply queued with once() in one test must not leak into the next.
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../auth', () => require('./authMock').authMockModule());

import * as api from '../../api';
import { installFakeServer } from './fakeServer';

const GROCERIES = { id: 'groceries', name: 'Groceries', bucket: 'Essentials', icon: 'cart', color: '#00AA00' };

describe('WHIT-639 fake server once() reset', () => {
  const server = installFakeServer();

  it('queues two replies but uses only one', async () => {
    server.once('GET', '/categories', { body: [GROCERIES] });
    server.once('GET', '/categories', { status: 500 });
    await expect(api.fetchCategories()).resolves.toEqual([GROCERIES]);
  });

  it('starts the next test with an empty queue', async () => {
    await expect(api.fetchCategories()).resolves.toEqual([]);
  });
});
