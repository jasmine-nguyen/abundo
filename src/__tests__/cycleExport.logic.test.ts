// WHIT-700 — buildCycleCsv turns one pay cycle's transactions into the exported .csv text.
// Expected strings are written out by hand from the card's column spec.
import { describe, it, expect } from '@jest/globals';
import { buildCycleCsv, cycleCsvFileName } from '../cycleExport';
import { cat, txn } from './factory';
import type { Category } from '../types';

const BOM = '﻿';
const HEADER = 'Date,Amount,Parent category,Category,Description,Account,Status,Counts to budget';

const CATS: Category[] = [
  cat({ id: 'food', name: 'Food', parent: null }),
  cat({ id: 'eating-out', name: 'Eating out', parent: 'food' }),
  cat({ id: 'coffee', name: 'Cafes & Coffee', parent: 'eating-out' }),   // 3 levels deep
  cat({ id: 'groceries', name: 'Groceries', parent: null }),
  cat({ id: 'orphan', name: 'Orphan', parent: 'gone' }),                 // parent the app doesn't know
];
const category = (id: string) => CATS.find((c) => c.id === id);

describe('buildCycleCsv', () => {
  it('user can export a cycle as a CSV that groups by top-level parent category', () => {
    const rows = [
      { ...txn({ transaction_id: 'a', date: '2026-07-25', amount: -12.5, category: 'coffee',
          merchant_name: 'Bean, "The" Cafe', account_name: 'Everyday', status: 'pending' }),
        counts_to_budget_effective: true },
      { ...txn({ transaction_id: 'b', date: '2026-07-20', amount: 1000, category: 'groceries',
          merchant_name: '', description: 'PAY\nROLL', account_name: 'Savings', status: 'posted' }),
        counts_to_budget_effective: false },
      { ...txn({ transaction_id: 'c', date: '2026-07-10', amount: -3, category: null,
          merchant_name: 'Kiosk', account_name: 'Everyday', status: 'posted' }),
        counts_to_budget_effective: true },
      { ...txn({ transaction_id: 'd', date: '2026-07-05', amount: -7.1, category: 'not-a-category',
          merchant_name: 'Mystery', account_name: 'Everyday', status: 'posted' }),
        counts_to_budget_effective: false },
      { ...txn({ transaction_id: 'e', date: '2026-07-02', amount: -20, category: 'orphan',
          merchant_name: 'Shop', account_name: 'Everyday', status: 'posted' }),
        counts_to_budget_effective: true },
      { ...txn({ transaction_id: 'f', date: '2026-07-01', amount: -4.25, category: 'eating-out',
          merchant_name: 'Diner', account_name: 'Everyday', status: 'posted' }),
        counts_to_budget_effective: true },
    ];

    const csv = buildCycleCsv(rows, category);

    expect(csv).toBe(
      BOM +
        [
          HEADER,
          '2026-07-25,-12.50,Food,Cafes & Coffee,"Bean, ""The"" Cafe",Everyday,pending,Yes',
          '2026-07-20,1000.00,Groceries,Groceries,"PAY\nROLL",Savings,posted,No',
          '2026-07-10,-3.00,Uncategorised,Uncategorised,Kiosk,Everyday,posted,Yes',
          '2026-07-05,-7.10,Uncategorised,Uncategorised,Mystery,Everyday,posted,No',
          '2026-07-02,-20.00,Orphan,Orphan,Shop,Everyday,posted,Yes',
          '2026-07-01,-4.25,Food,Eating out,Diner,Everyday,posted,Yes',
        ].join('\r\n'),
    );
    expect(cycleCsvFileName('2026-06-01', '2026-06-30')).toBe('transactions_2026-06-01_to_2026-06-30.csv');
  });
});
