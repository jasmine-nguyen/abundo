// WHIT-700 / WHIT-703 QA — adversarial edges of the cycle export: the Transactions tab's
// cell rows, the fetch path, and the write-file → share-menu step (native modules mocked at
// the boundary).
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => require('./support/authMock').authTokenSpyModule('test-token'));

const fileInstances: { args: unknown[]; created: unknown[]; written: unknown[]; uri: string }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' } },
  File: class {
    args: unknown[];
    created: unknown[] = [];
    written: unknown[] = [];
    uri = 'file:///cache/out.xlsx';
    constructor(...args: unknown[]) {
      this.args = args;
      fileInstances.push(this);
    }
    create(options: unknown) { this.created.push(options); }
    write(content: unknown) { this.written.push(content); }
  },
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

import * as Sharing from 'expo-sharing';
import { strFromU8, unzipSync } from 'fflate';
import { Paths } from 'expo-file-system';
import { buildCycleWorkbook, buildTransactionRows, cycleFileName, TRANSACTION_HEADER } from '../cycleExport';
import { shareCycleExport } from '../cycleShare';
import { fetchCycleTransactions } from '../api';
import type { CycleTransaction } from '../api';
import { cat, txn } from './factory';
import type { Category } from '../types';

const shareAsync = Sharing.shareAsync as jest.MockedFunction<typeof Sharing.shareAsync>;

function row(over: Partial<CycleTransaction> = {}): CycleTransaction {
  return { ...txn(), counts_to_budget_effective: true, ...over };
}

function lookup(cats: Category[]) {
  return (id: string) => cats.find((c) => c.id === id);
}

function dataRows(rows: CycleTransaction[], cats: Category[] = []) {
  return buildTransactionRows(rows, lookup(cats)).slice(1);
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

describe('buildTransactionRows edges', () => {
  // [A8] an empty cycle → header row only.
  it('an empty cycle exports just the header', () => {
    expect(buildTransactionRows([], lookup([]))).toEqual([TRANSACTION_HEADER]);
  });

  // [A12] no merchant name (null or empty) falls back to the description.
  it('falls back to the description when merchant_name is null or empty', () => {
    const rows = dataRows([
      row({ merchant_name: null as unknown as string, description: 'DIRECT DEBIT' }),
      row({ merchant_name: '', description: 'ATM' }),
    ]);
    expect(rows.map((r) => r[4])).toEqual(['DIRECT DEBIT', 'ATM']);
  });

  // [A13] amounts stay numbers with their sign, so Excel can sum them.
  it.each([-12.5, 1000, 1234567.8, 0, -0.07])('amount %p stays a number', (amount) => {
    const [cells] = dataRows([row({ amount })]);
    expect(cells[1]).toBe(amount);
  });

  // [A14] the top-level walk: a 6-level chain reaches the root within the 5-step cap.
  it('a 6-level chain resolves to the root', () => {
    const cats = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) =>
      cat({ id, name: id.toUpperCase(), parent: i === 0 ? null : `l${i - 1}` }));
    const [cells] = dataRows([row({ category: 'l5' })], cats);
    expect(cells.slice(2, 4)).toEqual(['L0', 'L5']);
  });

  // [A15] a parent loop (a → b → a) can't hang the export; it still produces a named row.
  it('a parent loop terminates', () => {
    const cats = [cat({ id: 'a', name: 'A', parent: 'b' }), cat({ id: 'b', name: 'B', parent: 'a' })];
    const [cells] = dataRows([row({ category: 'a' })], cats);
    expect(['A', 'B']).toContain(cells[2]);
    expect(cells[3]).toBe('A');
  });

  // [A16] the category with a parent that's its own id doesn't loop either.
  it('a self-parented category is its own top level', () => {
    const cats = [cat({ id: 'a', name: 'A', parent: 'a' })];
    const [cells] = dataRows([row({ category: 'a' })], cats);
    expect(cells.slice(2, 4)).toEqual(['A', 'A']);
  });

  // [A17] rows keep the server's order (newest first) — the builder must not re-sort.
  it('keeps the given row order', () => {
    const rows = dataRows([row({ date: '2026-07-03' }), row({ date: '2026-07-01' }), row({ date: '2026-07-02' })]);
    expect(rows.map((r) => r[0])).toEqual(['2026-07-03', '2026-07-01', '2026-07-02']);
  });

  // [A18] every data row has exactly 8 cells.
  it('each row has 8 cells', () => {
    const [cells] = dataRows([row({ merchant_name: 'a,b,c', account_name: 'x' })]);
    expect(cells).toHaveLength(8);
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

describe('shareCycleExport', () => {
  const cats = [cat({ id: 'food', name: 'Food', parent: null }), cat({ name: 'Coffee', parent: 'food' })];
  const transactions = [row({ category: 'coffee', amount: -4.5 })];

  // [A21] fetch → file named after the window in the cache dir, overwritten → workbook bytes
  // written → share menu opened on that file as an Excel file.
  it('writes the cycle workbook to a named cache file and shares it', async () => {
    const data = { start: '2026-06-01', end: '2026-06-30', transactions };
    mockFetch(data);

    await shareCycleExport(0, lookup(cats));

    expect(fileInstances).toHaveLength(1);
    const [file] = fileInstances;
    expect(file.args).toEqual([Paths.cache, cycleFileName('2026-06-01', '2026-06-30')]);
    expect(file.written).toEqual([buildCycleWorkbook(data, lookup(cats), false)]);
    const sheet = strFromU8(unzipSync(file.written[0] as Uint8Array)['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<v>-4.5</v>');
    expect(sheet).toContain('>Coffee<');
    expect(shareAsync.mock.calls[0][1]).toMatchObject({
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      UTI: 'org.openxmlformats.spreadsheetml.sheet',
    });
  });

  // [A22] a failed fetch writes nothing and never opens the share menu, and the error surfaces.
  it('a failed fetch rejects without writing or sharing', async () => {
    mockFetch({ error: 'boom' }, 500);
    await expect(shareCycleExport(0, lookup(cats))).rejects.toBeTruthy();
    expect(fileInstances).toHaveLength(0);
    expect(shareAsync).not.toHaveBeenCalled();
  });

  // [A23] a share-menu failure propagates (so the button can alert), not swallowed.
  it('a share failure rejects', async () => {
    mockFetch({ start: 'a', end: 'b', transactions: [] });
    shareAsync.mockRejectedValueOnce(new Error('no share'));
    await expect(shareCycleExport(0, lookup(cats))).rejects.toThrow('no share');
  });
});
