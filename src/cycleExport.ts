// WHIT-700: turn one pay cycle's transactions into CSV text for the Insights export.
// Pure — no screen or file access — so it runs in the fast logic tests.
import type { CycleTransaction } from './api';
import type { Category } from './types';

const BOM = '﻿';
const UNCATEGORISED = 'Uncategorised';
const MAX_PARENT_STEPS = 5;

export const CSV_HEADER = [
  'Date', 'Amount', 'Parent category', 'Category', 'Description', 'Account', 'Status', 'Counts to budget',
];

function escapeField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// The top-level ancestor, so the file groups by the categories the user sees at the top.
// Stops at the last known category if a parent id is unknown, and after a few steps so a
// broken parent link can't loop forever.
function topLevel(start: Category, category: (id: string) => Category | undefined): Category {
  let current = start;
  for (let step = 0; step < MAX_PARENT_STEPS; step++) {
    const parent = current.parent ? category(current.parent) : undefined;
    if (!parent) return current;
    current = parent;
  }
  return current;
}

function categoryColumns(id: string | null, category: (id: string) => Category | undefined): [string, string] {
  const own = id ? category(id) : undefined;
  if (!own) return [UNCATEGORISED, UNCATEGORISED];
  return [topLevel(own, category).name, own.name];
}

export function buildCycleCsv(
  rows: CycleTransaction[],
  category: (id: string) => Category | undefined,
): string {
  const lines = rows.map((row) => {
    const [parentName, categoryName] = categoryColumns(row.category, category);
    return [
      row.date,
      row.amount.toFixed(2),
      parentName,
      categoryName,
      row.merchant_name || row.description,
      row.account_name,
      row.status,
      row.counts_to_budget_effective ? 'Yes' : 'No',
    ].map(escapeField).join(',');
  });
  return BOM + [CSV_HEADER.join(','), ...lines].join('\r\n');
}

export function cycleCsvFileName(start: string, end: string): string {
  return `transactions_${start}_to_${end}.csv`;
}
