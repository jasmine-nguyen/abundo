// WHIT-840 — one error style, and no ignored length on the budgets/spending reads.
// Every endpoint rejects with an ApiError ('API error: N'); only the three category writes carry
// the server's reason. /budgets and /breakdown are requested without `days`.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule());

import { getAuthToken } from '../auth';
import * as api from '../api';
import { ApiError } from '../apiError';
import { REASON_ENDPOINTS, WIRE } from './support/apiWire';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const BASE = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';
const STATUS = 418;
const LEAK = 'LEAKED SERVER REASON';
let fetchMock: jest.Mock;

function failWithReason() {
  fetchMock = jest.fn(() =>
    Promise.resolve({ ok: false, status: STATUS, json: () => Promise.resolve({ error: LEAK }) }));
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
}

beforeEach(() => {
  mockGetAuthToken.mockReset();
  mockGetAuthToken.mockResolvedValue('tok');
  failWithReason();
});

describe('every failed request is an ApiError', () => {
  it.each(Object.keys(WIRE))('%s', async (name) => {
    const error = (await WIRE[name][0]().then(() => null, (e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(`API error: ${STATUS}`);
    expect(error.serverMessage).toBe(REASON_ENDPOINTS.includes(name) ? LEAK : null);
  });
});

describe('budgets and spending reads send no length', () => {
  it.each([
    ['fetchBudgets()', () => api.fetchBudgets(), '/budgets'],
    ['fetchBreakdown()', () => (api.fetchBreakdown as (cycle?: number) => Promise<unknown>)(), '/breakdown'],
    ['fetchBreakdown(0)', () => (api.fetchBreakdown as (cycle?: number) => Promise<unknown>)(0), '/breakdown'],
    ['fetchBreakdown(2)', () => (api.fetchBreakdown as (cycle?: number) => Promise<unknown>)(2), '/breakdown?cycle=2'],
  ] as const)('%s', async (_label, call, path) => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
    await call();
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${BASE}${path}`);
  });
});
