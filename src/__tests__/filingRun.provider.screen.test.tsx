// WHIT-629 slice 2 — one filing run through the app's data context.
//
// A sheet says what to file (a FilingTarget) and how many charges the preview matched; the context
// picks "file now" or "background job" and hands back one FilingResult. These tests prove the
// choice lives in the context, not the sheet, and that every path answers in the same shape.
import { it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';
import { useAppContext } from '../context';
import type { ApplyRulesResult, FilingResult, FilingTarget } from '../context';
import type { UncategorizedMerchantGroup } from '../api';
import { ApiError } from '../apiError';
import { queryClient } from '../queryClient';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
import { resetAuth } from './support/authMock';
import { installFakeServer } from './support/fakeServer';
import { applyRulesReport } from './support/applyRulesReport';
import { appProviderWrapper as wrapper } from './support/renderWithApp';

const server = installFakeServer();
const APPLY_RULES = '/transactions/uncategorized/apply-rules';
const JOBS = `${APPLY_RULES}/jobs`;
const posts = (path: string) => server.sent('POST', path);

const GROUP: UncategorizedMerchantGroup = {
  merchant: 'Coles', rulePattern: 'coles', groupedBy: 'merchant', count: 999,
  samples: ['COLES 1234'], firstDate: '2026-06-01', lastDate: '2026-08-01', alsoCatches: [],
};
const SHOP: FilingTarget = { kind: 'shop', group: GROUP, categoryId: 'groceries' };
const SWEEP: FilingTarget = { kind: 'sweep' };

const report = (over: Partial<ApplyRulesResult> = {}) => applyRulesReport({
  dryRun: false, rulesConsidered: 1, unfiled: 999, matched: 999, byCategory: { groceries: 300 }, remaining: 699,
  ...over,
});

function mount() { return renderHook(() => useAppContext(), { wrapper }).result; }

beforeEach(() => { queryClient.clear(); jest.useFakeTimers(); resetAuth(); });
afterEach(() => { jest.useRealTimers(); queryClient.clear(); });

it('sends a shop run over 300 charges to a background job and says so', async () => {
  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { matched: 999 }); });

  expect(result).toEqual({ status: 'background' });
  expect(server.requests()).toContainEqual({ method: 'POST', path: JOBS, body: { rule: { value: 'coles', categoryId: 'groceries' } } });
  expect(posts(APPLY_RULES)).toHaveLength(0);
  expect(r.current.applyRulesJob?.status).toBe('running');
});

it('files a shop run of 300 charges now and returns the report', async () => {
  server.seed(APPLY_RULES, report({ matched: 300, remaining: 0 }));

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SHOP, { matched: 300 }); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 300 }) });
  expect(server.requests()).toContainEqual({
    method: 'POST', path: APPLY_RULES, body: { dryRun: false, rule: { value: 'coles', categoryId: 'groceries' } },
  });
  expect(posts(JOBS)).toHaveLength(0);
});

it('files the first 300 now, even over the cap, when the user picks "file up to 300"', async () => {
  server.seed(APPLY_RULES, report());

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.fileCharges(SWEEP, { matched: 999, now: true }); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ matched: 999 }) });
  expect(posts(APPLY_RULES)).toHaveLength(1);
  expect(posts(APPLY_RULES)[0].body).toMatchObject({ dryRun: false });
  expect(posts(APPLY_RULES)[0].body).not.toHaveProperty('rule');
  expect(posts(JOBS)).toHaveLength(0);
});

it('reports a rule clash with where it came from: filing now vs starting a job', async () => {
  server.fail(APPLY_RULES, 409);
  server.fail(JOBS, 409);

  const r = mount();
  let now: FilingResult | null = null;
  let background: FilingResult | null = null;
  await act(async () => { now = await r.current.fileCharges(SHOP, { matched: 5 }); });
  await act(async () => { background = await r.current.fileCharges(SHOP, { matched: 999 }); });

  expect(now).toEqual({ status: 'clash', error: expect.any(ApiError), background: false });
  expect(background).toEqual({ status: 'clash', error: expect.any(ApiError), background: true });
});

it('previews through the same module and returns the same result shape', async () => {
  server.seed(APPLY_RULES, report({ dryRun: true }));

  const r = mount();
  let result: FilingResult | null = null;
  await act(async () => { result = await r.current.previewFiling(SHOP); });

  expect(result).toEqual({ status: 'filed', report: expect.objectContaining({ dryRun: true, matched: 999 }) });
  expect(server.requests()).toContainEqual({
    method: 'POST', path: APPLY_RULES, body: { dryRun: true, rule: { value: 'coles', categoryId: 'groceries' } },
  });
});
