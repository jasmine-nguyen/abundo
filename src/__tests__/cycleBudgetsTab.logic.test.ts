// WHIT-703 slice 2 — the export's Budgets tab is filled from the server's `budgets`, in
// Budgets-screen order (Savings and unknown categories last). The workbook bytes are unzipped
// with fflate and each sheet's XML read back into a grid. Expected rows are written by hand
// from the card: Spent = posted + pending, Left to spend = Available − Spent, Carry-over =
// rollover buffer or spread adjustment; last cycle → 'Budget (current)', blank carry-over,
// Available = today's target.
import { describe, it, expect } from '@jest/globals';
import { unzipSync, strFromU8 } from 'fflate';
import { buildCycleWorkbook } from '../cycleExport';
import type { BudgetRollup, CycleTransactions } from '../api';
import type { Category } from '../types';
import { cat } from './factory';

const BUDGET_HEADER = [
  'Parent category', 'Category', 'Budget', 'Spent', 'Pending', 'Left to spend', 'Carry-over', 'Available',
];
const PAST_BUDGET_HEADER = [
  'Parent category', 'Category', 'Budget (current)', 'Spent', 'Pending', 'Left to spend', 'Carry-over', 'Available',
];

// ---- a tiny xlsx reader -------------------------------------------------------------

type ReadCell = { value: string | number; numeric: boolean; twoDecimals: boolean };

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? unescapeXml(match[1]) : undefined;
}

function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function textOf(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
}

function readWorkbook(bytes: Uint8Array): { names: string[]; sheets: Record<string, (ReadCell | null)[][]> } {
  const files = unzipSync(bytes);
  const read = (path: string) => strFromU8(files[path]);
  const targets: Record<string, string> = {};
  for (const [tag] of read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)) {
    targets[attr(tag, 'Id')!] = attr(tag, 'Target')!;
  }
  const sharedStrings: string[] = files['xl/sharedStrings.xml']
    ? [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];
  const numFmtCodes: Record<string, string> = {};
  const xfFormats: string[] = [];
  if (files['xl/styles.xml']) {
    const styles = read('xl/styles.xml');
    for (const [tag] of styles.matchAll(/<numFmt\s[^>]*>/g)) numFmtCodes[attr(tag, 'numFmtId')!] = attr(tag, 'formatCode')!;
    const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfs) for (const [tag] of cellXfs[1].matchAll(/<xf\s[^>]*>/g)) xfFormats.push(attr(tag, 'numFmtId') ?? '0');
  }
  const isTwoDecimals = (style: string | undefined) => {
    const numFmtId = xfFormats[Number(style ?? 0)];
    return numFmtId === '2' || numFmtCodes[numFmtId ?? ''] === '0.00';
  };

  const names: string[] = [];
  const sheets: Record<string, (ReadCell | null)[][]> = {};
  for (const [tag] of read('xl/workbook.xml').matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(tag, 'name')!;
    const target = targets[attr(tag, 'r:id')!].replace(/^\/?(xl\/)?/, '');
    const grid: (ReadCell | null)[][] = [];
    for (const rowMatch of read(`xl/${target}`).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNumber = Number(attr(rowMatch[0].match(/<row\b[^>]*>/)![0], 'r') ?? grid.length + 1);
      const cells: (ReadCell | null)[] = [];
      for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const cellTag = `<c ${cellMatch[1]}>`;
        const inner = cellMatch[2] ?? '';
        const column = columnIndex(attr(cellTag, 'r')!.replace(/\d+/g, ''));
        const type = attr(cellTag, 't');
        const v = inner.match(/<v>([\s\S]*?)<\/v>/);
        let cell: ReadCell | null = null;
        if (type === 'inlineStr') cell = { value: textOf(inner), numeric: false, twoDecimals: false };
        else if (type === 's' && v) cell = { value: sharedStrings[Number(v[1])], numeric: false, twoDecimals: false };
        else if (type === 'str' && v) cell = { value: unescapeXml(v[1]), numeric: false, twoDecimals: false };
        else if (v) cell = { value: Number(v[1]), numeric: true, twoDecimals: isTwoDecimals(attr(cellTag, 's')) };
        while (cells.length < column) cells.push(null);
        cells[column] = cell;
      }
      while (cells.length && cells[cells.length - 1] === null) cells.pop();
      while (grid.length < rowNumber - 1) grid.push([]);
      grid[rowNumber - 1] = cells;
    }
    names.push(name);
    sheets[name] = grid;
  }
  return { names, sheets };
}

function values(grid: (ReadCell | null)[][]): (string | number | null)[][] {
  return grid.map((row) => row.map((cell) => (cell ? cell.value : null)));
}

// ---- fixtures -----------------------------------------------------------------------

const CATS: Category[] = [
  cat({ id: 'food', name: 'Food', bucket: 'Lifestyle', parent: null }),
  cat({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', parent: 'food' }),
  cat({ id: 'groceries', name: 'Groceries', bucket: 'Living', parent: null }),
  cat({ id: 'salary', name: 'Salary', bucket: 'Income', parent: null }),
  cat({ id: 'nest_egg', name: 'Nest egg', bucket: 'Savings', parent: null }),
  cat({ id: 'unbudgeted', name: 'Fun', bucket: 'Lifestyle', parent: null }),
];
const category = (id: string) => CATS.find((c) => c.id === id);

// Server order deliberately differs from the Budgets screen: the child comes before its
// parent, and the Savings budget sits in the middle.
const BUDGETS: Record<string, BudgetRollup> = {
  coffee: { target: 50, posted: 40, pending: 15 },                                           // over by 5
  groceries: { target: 100, posted: 100, pending: 0, rollover: true, carryover: 30, available: 130 },
  nest_egg: { target: 300, posted: 0, pending: 0 },                                           // Savings → last
  food: { target: 500, posted: 300.5, pending: 15, available: 700,
    spread: { amount: 800, cycles: 4, index: 0, adjustment: 200 } },
  mystery: { target: 20, posted: 5, pending: 0 },                                             // unknown category → last
  salary: { target: 4000, posted: 4100, pending: 0 },                                         // Income earn-target
};

function data(budgets?: Record<string, BudgetRollup>): CycleTransactions {
  return { start: '2026-07-01', end: '2026-07-25', transactions: [], ...(budgets ? { budgets } : {}) } as CycleTransactions;
}

describe('buildCycleWorkbook — Budgets tab', () => {
  it('user can export each budget, its category and its spend in Budgets-screen order, for this and last cycle', () => {
    const current = readWorkbook(buildCycleWorkbook(data(BUDGETS), category, false));
    expect(current.names).toEqual(['Transactions', 'Budgets']);
    expect(values(current.sheets.Budgets)).toEqual([
      BUDGET_HEADER,
      // Parent category, Category, Budget, Spent, Pending, Left to spend, Carry-over, Available
      ['Groceries', 'Groceries', 100, 100, 0, 30, 30, 130],
      ['Food', 'Food', 500, 315.5, 15, 384.5, 200, 700],
      ['Food', 'Cafes & Coffee', 50, 55, 15, -5, 0, 50],
      ['Salary', 'Salary', 4000, 4100, 0, -100, 0, 4000],
      ['Nest egg', 'Nest egg', 300, 0, 0, 300, 0, 300],
      ['Uncategorised', 'Uncategorised', 20, 5, 0, 15, 0, 20],
    ]);
    // Amounts are real numbers shown to 2 decimals, so Excel can sum them.
    for (const dataRow of current.sheets.Budgets.slice(1)) {
      expect(dataRow[0]?.numeric).toBe(false);
      expect(dataRow[1]?.numeric).toBe(false);
      for (const index of [2, 3, 4, 5, 6, 7]) {
        expect(dataRow[index]).toMatchObject({ numeric: true, twoDecimals: true });
      }
    }

    // Last cycle: past budgets aren't saved, so today's target is used and carry-over is blank.
    const past = readWorkbook(buildCycleWorkbook(data(BUDGETS), category, true));
    expect(values(past.sheets.Budgets)).toEqual([
      PAST_BUDGET_HEADER,
      ['Groceries', 'Groceries', 100, 100, 0, 0, null, 100],
      ['Food', 'Food', 500, 315.5, 15, 184.5, null, 500],
      ['Food', 'Cafes & Coffee', 50, 55, 15, -5, null, 50],
      ['Salary', 'Salary', 4000, 4100, 0, -100, null, 4000],
      ['Nest egg', 'Nest egg', 300, 0, 0, 300, null, 300],
      ['Uncategorised', 'Uncategorised', 20, 5, 0, 15, null, 20],
    ]);

    // An old server sends no `budgets` → the Budgets tab is its titles only.
    const oldServer = readWorkbook(buildCycleWorkbook(data(), category, false));
    expect(values(oldServer.sheets.Budgets)).toEqual([BUDGET_HEADER]);
  });
});
