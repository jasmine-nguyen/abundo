// WHIT-700 / WHIT-703 — buildTransactionRows turns one pay cycle's transactions into the
// Transactions tab's cells, and buildXlsx packs cell rows into an .xlsx (a zip of XML files).
// Expected values are written out by hand from the card's column spec.
import { describe, it, expect } from '@jest/globals';
import { strFromU8, unzipSync } from 'fflate';
import { buildTransactionRows, cycleFileName, TRANSACTION_HEADER } from '../cycleExport';
import { buildXlsx } from '../xlsx';
import { cat, txn } from './factory';
import type { Category } from '../types';

const CATS: Category[] = [
  cat({ id: 'food', name: 'Food', parent: null }),
  cat({ id: 'eating-out', name: 'Eating out', parent: 'food' }),
  cat({ id: 'coffee', name: 'Cafes & Coffee', parent: 'eating-out' }),   // 3 levels deep
  cat({ id: 'groceries', name: 'Groceries', parent: null }),
];
const category = (id: string) => CATS.find((c) => c.id === id);

function sheetXml(bytes: Uint8Array, n: number): string {
  return strFromU8(unzipSync(bytes)[`xl/worksheets/sheet${n}.xml`]);
}

describe('buildTransactionRows', () => {
  it('user can export a cycle grouped by top-level parent category, amounts kept as numbers', () => {
    const rows = [
      { ...txn({ transaction_id: 'a', date: '2026-07-25', amount: -12.5, category: 'coffee',
          merchant_name: 'Bean, "The" Cafe', account_name: 'Everyday', status: 'pending' }),
        counts_to_budget_effective: true },
      { ...txn({ transaction_id: 'b', date: '2026-07-20', amount: 1000, category: 'groceries',
          merchant_name: '', description: 'PAY', account_name: 'Savings', status: 'posted' }),
        counts_to_budget_effective: false },
    ];

    expect(buildTransactionRows(rows, category)).toEqual([
      ['Date', 'Amount', 'Parent category', 'Category', 'Description', 'Account', 'Status', 'Counts to budget'],
      ['2026-07-25', -12.5, 'Food', 'Cafes & Coffee', 'Bean, "The" Cafe', 'Everyday', 'pending', 'Yes'],
      ['2026-07-20', 1000, 'Groceries', 'Groceries', 'PAY', 'Savings', 'posted', 'No'],
    ]);
    expect(TRANSACTION_HEADER).toHaveLength(8);
  });

  it('names the file after the cycle window with the .xlsx extension', () => {
    expect(cycleFileName('2026-06-01', '2026-06-30')).toBe('transactions_2026-06-01_to_2026-06-30.xlsx');
  });
});

describe('buildXlsx', () => {
  it('lays out cells past column Z with the right letters and leaves blank cells out', () => {
    const row = Array.from({ length: 28 }, (_, i) => (i === 1 ? null : i));
    const xml = sheetXml(buildXlsx([{ name: 'S', rows: [row] }]), 1);

    expect(xml).toContain('<c r="A1" s="1"><v>0</v></c>');
    expect(xml).not.toContain('r="B1"');
    expect(xml).toContain('<c r="Z1" s="1"><v>25</v></c>');
    expect(xml).toContain('<c r="AA1" s="1"><v>26</v></c>');
    expect(xml).toContain('<c r="AB1" s="1"><v>27</v></c>');
  });

  it('escapes XML characters and drops control characters Excel would reject', () => {
    const xml = sheetXml(buildXlsx([{ name: 'S', rows: [['a & <b> "c" \'d\'\u0001\u0008e']] }]), 1);

    expect(xml).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;e</t></is></c>',
    );
  });

  it('lists every sheet in the workbook, each linked to its own part', () => {
    const files = unzipSync(buildXlsx([{ name: 'One', rows: [] }, { name: 'Two & more', rows: [] }]));
    const workbook = strFromU8(files['xl/workbook.xml']);
    const rels = strFromU8(files['xl/_rels/workbook.xml.rels']);
    const types = strFromU8(files['[Content_Types].xml']);

    expect(workbook).toContain('<sheet name="One" sheetId="1" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="Two &amp; more" sheetId="2" r:id="rId2"/>');
    expect(rels).toContain('Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet2.xml"');
    expect(files['xl/styles.xml']).toBeDefined();
    expect(files['_rels/.rels']).toBeDefined();
  });
});
