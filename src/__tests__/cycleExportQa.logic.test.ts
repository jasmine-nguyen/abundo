// WHIT-700 QA — adversarial edges of the cycle CSV export: the pure builder, the fetch path,
// and the write-file → share-menu step (native modules mocked at the boundary).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn(async () => 'test-token') }));

const fileInstances: { args: unknown[]; created: unknown[]; written: string[]; uri: string }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' } },
  File: class {
    args: unknown[];
    created: unknown[] = [];
    written: string[] = [];
    uri = 'file:///cache/out.csv';
    constructor(...args: unknown[]) {
      this.args = args;
      fileInstances.push(this);
    }
    create(options: unknown) { this.created.push(options); }
    write(text: string) { this.written.push(text); }
  },
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

import * as Sharing from 'expo-sharing';
import { Paths } from 'expo-file-system';
import { buildCycleCsv, cycleCsvFileName, CSV_HEADER } from '../cycleExport';
import { shareCycleCsv } from '../cycleShare';
import { fetchCycleTransactions } from '../api';
import type { CycleTransaction } from '../api';
import { cat, txn } from './factory';
import type { Category } from '../types';

const BOM = '﻿';
const shareAsync = Sharing.shareAsync as jest.MockedFunction<typeof Sharing.shareAsync>;

function row(over: Partial<CycleTransaction> = {}): CycleTransaction {
  return { ...txn(), counts_to_budget_effective: true, ...over };
}

function lookup(cats: Category[]) {
  return (id: string) => cats.find((c) => c.id === id);
}

function dataLines(csv: string): string[] {
  return csv.slice(BOM.length).split('\r\n').slice(1);
}

function mockFetch(body: unknown, status = 200) {
  const mock = jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

beforeEach(() => {
  fileInstances.length = 0;
  shareAsync.mockReset();
  shareAsync.mockResolvedValue(undefined);
});

describe('buildCycleCsv edges', () => {
  // [A8] an empty cycle → BOM + header only, no trailing blank line.
  it('an empty cycle exports just the header', () => {
    expect(buildCycleCsv([], lookup([]))).toBe(BOM + CSV_HEADER.join(','));
  });

  // [A9] the BOM appears exactly once, at the very start.
  it('puts the BOM only at the start', () => {
    const csv = buildCycleCsv([row(), row({ transaction_id: 't2' })], lookup([]));
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.split(BOM).length).toBe(2);
  });

  // [A10] a lone carriage return and a lone quote are escaped; a plain field is left bare.
  it('quotes a lone \\r and a lone quote, leaves plain text bare', () => {
    const [cr] = dataLines(buildCycleCsv([row({ merchant_name: 'A\rB' })], lookup([])));
    expect(cr.split(',')[4]).toBe('"A\rB"');
    const [quote] = dataLines(buildCycleCsv([row({ merchant_name: '"' })], lookup([])));
    expect(quote.split(',')[4]).toBe('""""');
    const [plain] = dataLines(buildCycleCsv([row({ merchant_name: "O'Brien's  Bar " })], lookup([])));
    expect(plain.split(',')[4]).toBe("O'Brien's  Bar ");
  });

  // [A11] a comma inside a CATEGORY or ACCOUNT name is escaped too, not just the description.
  it('escapes commas in category and account names', () => {
    const cats = [cat({ id: 'p', name: 'Food, Drink', parent: null }), cat({ id: 'c', name: 'Bars "late"', parent: 'p' })];
    const [line] = dataLines(buildCycleCsv([row({ category: 'c', account_name: 'Joint, Up' })], lookup(cats)));
    expect(line).toBe('2026-07-01,-12.50,"Food, Drink","Bars ""late""",Woolworths,"Joint, Up",posted,Yes');
  });

  // [A12] no merchant name (null or empty) falls back to the description.
  it('falls back to the description when merchant_name is null or empty', () => {
    const csv = buildCycleCsv(
      [row({ merchant_name: null as unknown as string, description: 'DIRECT DEBIT' }), row({ merchant_name: '', description: 'ATM' })],
      lookup([]),
    );
    expect(dataLines(csv).map((l) => l.split(',')[4])).toEqual(['DIRECT DEBIT', 'ATM']);
  });

  // [A13] amounts: plain numbers, 2 decimals, sign kept, no $ or thousands separator, float dust rounded.
  it.each([
    [-12.5, '-12.50'],
    [1000, '1000.00'],
    [1234567.8, '1234567.80'],
    [0, '0.00'],
    [0.1 + 0.2, '0.30'],
    [-0.07, '-0.07'],
  ])('amount %p → %s', (amount, expected) => {
    const [line] = dataLines(buildCycleCsv([row({ amount })], lookup([])));
    expect(line.split(',')[1]).toBe(expected);
  });

  // [A14] the top-level walk: a 6-level chain reaches the root within the 5-step cap.
  it('a 6-level chain resolves to the root', () => {
    const cats = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) =>
      cat({ id, name: id.toUpperCase(), parent: i === 0 ? null : `l${i - 1}` }));
    const [line] = dataLines(buildCycleCsv([row({ category: 'l5' })], lookup(cats)));
    expect(line.split(',').slice(2, 4)).toEqual(['L0', 'L5']);
  });

  // [A15] a parent loop (a → b → a) can't hang the export; it still produces a named row.
  it('a parent loop terminates', () => {
    const cats = [cat({ id: 'a', name: 'A', parent: 'b' }), cat({ id: 'b', name: 'B', parent: 'a' })];
    const [line] = dataLines(buildCycleCsv([row({ category: 'a' })], lookup(cats)));
    expect(['A', 'B']).toContain(line.split(',')[2]);
    expect(line.split(',')[3]).toBe('A');
  });

  // [A16] the category with a parent that's its own id doesn't loop either.
  it('a self-parented category is its own top level', () => {
    const cats = [cat({ id: 'a', name: 'A', parent: 'a' })];
    const [line] = dataLines(buildCycleCsv([row({ category: 'a' })], lookup(cats)));
    expect(line.split(',').slice(2, 4)).toEqual(['A', 'A']);
  });

  // [A17] rows keep the server's order (newest first) — the builder must not re-sort.
  it('keeps the given row order', () => {
    const csv = buildCycleCsv(
      [row({ date: '2026-07-03' }), row({ date: '2026-07-01' }), row({ date: '2026-07-02' })],
      lookup([]),
    );
    expect(dataLines(csv).map((l) => l.slice(0, 10))).toEqual(['2026-07-03', '2026-07-01', '2026-07-02']);
  });

  // [A18] every data line has exactly 8 columns (a CSV parser sees no shifted fields).
  it('each line has 8 columns once quoted fields are accounted for', () => {
    const csv = buildCycleCsv([row({ merchant_name: 'a,b,c', account_name: 'x' })], lookup([]));
    const [line] = dataLines(csv);
    const fields = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((f) => f !== '');
    expect(fields).toHaveLength(8);
  });
});

describe('fetchCycleTransactions', () => {
  // [A19] this cycle sends no query string; last cycle sends ?cycle=1.
  it('only adds ?cycle= for a past cycle', async () => {
    const fetchMock = mockFetch({ start: 's', end: 'e', transactions: [] });
    await fetchCycleTransactions(0);
    await fetchCycleTransactions();
    await fetchCycleTransactions(1);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls[0]).toMatch(/\/transactions\/cycle$/);
    expect(urls[1]).toMatch(/\/transactions\/cycle$/);
    expect(urls[2]).toMatch(/\/transactions\/cycle\?cycle=1$/);
  });

  // [A20] a server error rejects (so the button shows its alert).
  it('rejects on a 400', async () => {
    mockFetch({ error: 'bad' }, 400);
    await expect(fetchCycleTransactions(1)).rejects.toBeTruthy();
  });
});

describe('shareCycleCsv', () => {
  const cats = [cat({ id: 'food', name: 'Food', parent: null }), cat({ id: 'coffee', name: 'Coffee', parent: 'food' })];
  const transactions = [row({ category: 'coffee', amount: -4.5 })];

  // [A21] fetch → file named after the window in the cache dir, overwritten → CSV written →
  // share menu opened on that file as text/csv.
  it('writes the cycle CSV to a named cache file and shares it', async () => {
    const fetchMock = mockFetch({ start: '2026-06-01', end: '2026-06-30', transactions });

    await shareCycleCsv(1, lookup(cats));

    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toMatch(/\/transactions\/cycle\?cycle=1$/);
    expect(fileInstances).toHaveLength(1);
    const [file] = fileInstances;
    expect(file.args).toEqual([Paths.cache, 'transactions_2026-06-01_to_2026-06-30.csv']);
    expect(file.args[1]).toBe(cycleCsvFileName('2026-06-01', '2026-06-30'));
    expect(file.created).toEqual([{ overwrite: true }]);
    expect(file.written).toEqual([buildCycleCsv(transactions, lookup(cats))]);
    expect(file.written[0]).toContain('-4.50,Food,Coffee');
    expect(shareAsync).toHaveBeenCalledTimes(1);
    const [uri, options] = shareAsync.mock.calls[0];
    expect(uri).toBe(file.uri);
    expect(options).toMatchObject({ mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' });
  });

  // [A22] a failed fetch writes nothing and never opens the share menu, and the error surfaces.
  it('a failed fetch rejects without writing or sharing', async () => {
    mockFetch({ error: 'boom' }, 500);
    await expect(shareCycleCsv(0, lookup(cats))).rejects.toBeTruthy();
    expect(fileInstances).toHaveLength(0);
    expect(shareAsync).not.toHaveBeenCalled();
  });

  // [A23] a share-menu failure propagates (so the button can alert), not swallowed.
  it('a share failure rejects', async () => {
    mockFetch({ start: 'a', end: 'b', transactions: [] });
    shareAsync.mockRejectedValueOnce(new Error('no share'));
    await expect(shareCycleCsv(0, lookup(cats))).rejects.toThrow('no share');
  });
});
