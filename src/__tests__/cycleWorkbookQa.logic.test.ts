// WHIT-703 slice 1 QA — adversarial edges of the .xlsx writer and the cycle workbook:
// every part is strict, well-formed XML (Excel refuses a file that isn't), the package
// wiring is complete, text that looks like a number stays text, and odd strings survive.
import { describe, it, expect } from '@jest/globals';
import { strFromU8, unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { buildXlsx } from '../xlsx';
import { buildCycleWorkbook, BUDGET_HEADER, TRANSACTION_HEADER } from '../cycleExport';
import type { CycleTransaction } from '../api';
import { cat, txn } from './factory';
import type { Category } from '../types';

const CATS: Category[] = [cat({ id: 'food', name: 'Food', parent: null })];
const category = (id: string) => CATS.find((c) => c.id === id);

function row(over: Partial<CycleTransaction> = {}): CycleTransaction {
  return { ...txn(), counts_to_budget_effective: true, ...over };
}

function parts(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([path, data]) => [path, strFromU8(data)]));
}

function assertWellFormed(xml: string) {
  const parser = new SaxesParser({ xmlns: true });
  let error: Error | null = null;
  parser.on('error', (e) => { error = error ?? e; });
  parser.write(xml).close();
  if (error) throw error;
}

// The cells of one sheet as [ref, type, style, text-or-value] in document order.
function cells(xml: string) {
  return [...xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)].map(([, ref, attrs, inner]) => ({
    ref,
    inlineStr: attrs.includes('t="inlineStr"'),
    style: attrs.match(/s="(\d+)"/)?.[1],
    text: inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1],
    value: inner.match(/<v>([\s\S]*?)<\/v>/)?.[1],
  }));
}

const NASTY: CycleTransaction[] = [
  row({ date: '2026-07-25', amount: -12.5, category: 'food', merchant_name: 'Tom & Jerry\'s <"Bar">',
    account_name: 'Every & day', status: 'pending' }),
  row({ date: '2026-07-24', amount: 0, category: null, merchant_name: '  padded  ', account_name: 'A', status: 'posted' }),
  row({ date: '2026-07-23', amount: -0.07, category: 'food', merchant_name: 'Café ☕ 🍩 — 東京',
    account_name: 'B', status: 'posted' }),
  row({ date: '2026-07-22', amount: 1234567.89, category: 'food', merchant_name: '007',
    account_name: '1e5', status: 'posted', counts_to_budget_effective: false }),
  row({ date: '2026-07-21', amount: -5, category: 'food', merchant_name: 'Ctrl\u0000\u0007\u001Fchars\ttab\r\nline',
    account_name: 'C', status: 'posted' }),
];

describe('buildCycleWorkbook package', () => {
  // [A1] (P0) every XML part — including sheets full of XML-special, control and unicode
  // characters — is strict well-formed XML 1.0, so Excel/Numbers open it without repair.
  it('every part of the workbook is well-formed XML', () => {
    const files = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions: NASTY }, category, false));
    for (const [path, xml] of Object.entries(files)) {
      expect(() => assertWellFormed(xml)).not.toThrow();
      expect(path).toMatch(/\.(xml|rels)$/);
    }
  });

  // [A2] (P0) the package is wired: content types declare the workbook, styles and both sheets;
  // the workbook rels point at both sheets and the styles part; nothing points at a missing part.
  it('content types and relationships cover every part, and every target exists', () => {
    const files = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions: [] }, category, false));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
      'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml',
    ]);

    const types = files['[Content_Types].xml'];
    expect(types).toContain('PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"');
    expect(types).toContain('PartName="/xl/styles.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(types).toContain('PartName="/xl/worksheets/sheet2.xml"');

    expect(files['_rels/.rels']).toContain('Target="xl/workbook.xml"');
    const rels = files['xl/_rels/workbook.xml.rels'];
    const targets = [...rels.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    expect(targets.sort()).toEqual(['styles.xml', 'worksheets/sheet1.xml', 'worksheets/sheet2.xml']);
    for (const target of targets) expect(files[`xl/${target}`]).toBeDefined();
    const ids = [...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);

    // Every r:id the workbook names resolves to a worksheet relationship.
    for (const [, id] of files['xl/workbook.xml'].matchAll(/r:id="([^"]+)"/g)) {
      expect(rels).toMatch(new RegExp(`Id="${id}" [^>]*/worksheet" Target="worksheets/`));
    }
  });

  // [A3] (P0) style 1 — what every number cell uses — is the built-in 2-decimal format, and
  // the cellXfs count matches the entries (Excel flags a mismatch as corrupt).
  it('number cells use a 2-decimal style that exists', () => {
    const styles = parts(buildXlsx([{ name: 'S', rows: [[1]] }]))['xl/styles.xml'];
    const cellXfs = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/)!;
    const xfs = [...cellXfs[2].matchAll(/<xf [^>]*\/>/g)].map((m) => m[0]);
    expect(Number(cellXfs[1])).toBe(xfs.length);
    expect(xfs[1]).toContain('numFmtId="2"');
    expect(xfs[1]).toContain('applyNumberFormat="1"');
  });
});

describe('Transactions tab cells', () => {
  const sheet = () => parts(buildCycleWorkbook({ start: 's', end: 'e', transactions: NASTY }, category, false))[
    'xl/worksheets/sheet1.xml'];

  // [A4] (P0) only the Amount column (B) is numeric; every other column — including text that
  // looks like a number ('007', '1e5') and the date — stays a text cell, so nothing is mangled.
  it('only the Amount column is numeric; number-like text stays text', () => {
    const all = cells(sheet());
    const data = all.filter((c) => !/^[A-Z]+1$/.test(c.ref));
    for (const c of data) {
      if (c.ref.startsWith('B')) {
        expect(c).toMatchObject({ inlineStr: false, style: '1' });
      } else {
        expect(c.inlineStr).toBe(true);
        expect(c.value).toBeUndefined();
      }
    }
    expect(all.find((c) => c.ref === 'E5')?.text).toBe('007');
    expect(all.find((c) => c.ref === 'F5')?.text).toBe('1e5');
    expect(all.find((c) => c.ref === 'A2')?.text).toBe('2026-07-25');
  });

  // [A5] (P0) amounts are written exactly — sign, zero, tiny and large values — so a SUM in
  // Excel matches the app.
  it('amount values round-trip exactly', () => {
    const amounts = cells(sheet()).filter((c) => /^B\d+$/.test(c.ref) && c.ref !== 'B1').map((c) => Number(c.value));
    expect(amounts).toEqual([-12.5, 0, -0.07, 1234567.89, -5]);
  });

  // [A6] (P1) the header row is row 1, text, all 8 titles A..H; data rows follow 2..n with no gaps.
  it('header is row 1 and rows are numbered without gaps', () => {
    const xml = sheet();
    const header = cells(xml).filter((c) => /^[A-Z]+1$/.test(c.ref));
    expect(header.map((c) => c.ref)).toEqual(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1']);
    expect(header.map((c) => c.text)).toEqual(TRANSACTION_HEADER);
    expect(header.every((c) => c.inlineStr)).toBe(true);
    const rowNumbers = [...xml.matchAll(/<row r="(\d+)">/g)].map((m) => Number(m[1]));
    expect(rowNumbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // [A7] (P1) unicode (accents, emoji, CJK) survives the UTF-8 zip, padding whitespace is kept,
  // tabs/newlines are kept, and control characters XML forbids are dropped.
  it('keeps unicode and whitespace, drops forbidden control characters', () => {
    const all = cells(sheet());
    expect(all.find((c) => c.ref === 'E4')?.text).toBe('Café ☕ 🍩 — 東京');
    expect(all.find((c) => c.ref === 'E3')?.text).toBe('  padded  ');
    expect(all.find((c) => c.ref === 'E6')?.text).toBe('Ctrlchars\ttab\r\nline');
    expect(sheet()).toContain('xml:space="preserve"');
  });

  // [A8] (P1) a missing description (merchant name blank, description null) leaves a blank
  // cell rather than crashing or writing "null".
  it('a null description becomes a blank cell, not "null"', () => {
    const transactions = [row({ merchant_name: '', description: null as unknown as string })];
    const xml = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions }, category, false))['xl/worksheets/sheet1.xml'];
    expect(xml).not.toContain('>null<');
    expect(cells(xml).find((c) => c.ref === 'E2')).toBeUndefined();
    expect(cells(xml).find((c) => c.ref === 'F2')).toBeDefined();
  });

  // [A9] (P2) a big cycle (2,000 transactions) builds quickly and keeps every row.
  it('a 2,000-row cycle keeps every row', () => {
    const transactions = Array.from({ length: 2000 }, (_, i) => row({ amount: -i / 100, merchant_name: `M${i}` }));
    const xml = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions }, category, false))['xl/worksheets/sheet1.xml'];
    expect(xml.match(/<row /g)).toHaveLength(2001);
    expect(xml).toContain('<c r="B2001" s="1"><v>-19.99</v></c>');
  });
});

describe('Budgets tab in slice 1', () => {
  // [A10] (P0) this cycle AND last cycle: the Budgets tab is the 8 titles in row 1 and nothing
  // else, and the Transactions tab is unaffected by the past-cycle flag.
  it.each([false, true])('isPastCycle=%p → Budgets tab is the header row only', (isPastCycle) => {
    const files = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions: NASTY }, category, isPastCycle));
    const budgets = files['xl/worksheets/sheet2.xml'];
    expect(budgets.match(/<row /g)).toHaveLength(1);
    expect(cells(budgets).map((c) => c.text)).toEqual(BUDGET_HEADER);
    expect(files['xl/workbook.xml']).toMatch(/<sheet name="Transactions" sheetId="1"[^>]*\/><sheet name="Budgets" sheetId="2"/);

    const presentFlag = parts(buildCycleWorkbook({ start: 's', end: 'e', transactions: NASTY }, category, false));
    expect(files['xl/worksheets/sheet1.xml']).toBe(presentFlag['xl/worksheets/sheet1.xml']);
  });
});

describe('buildXlsx', () => {
  // [A11] (P1) a sheet with no rows is still a valid, well-formed worksheet.
  it('an empty sheet is valid', () => {
    const xml = parts(buildXlsx([{ name: 'Empty', rows: [] }]))['xl/worksheets/sheet1.xml'];
    expect(() => assertWellFormed(xml)).not.toThrow();
    expect(xml).toContain('<sheetData></sheetData>');
  });

  // [A12] (P1) column letters run A..Z, AA..AZ, BA.. and ZZ → AAA without skipping.
  it('column letters roll over correctly', () => {
    const width = 703;
    const xml = parts(buildXlsx([{ name: 'W', rows: [Array.from({ length: width }, () => 1)] }]))['xl/worksheets/sheet1.xml'];
    const refs = cells(xml).map((c) => c.ref.replace(/\d+$/, ''));
    expect(refs[0]).toBe('A');
    expect(refs[25]).toBe('Z');
    expect(refs[26]).toBe('AA');
    expect(refs[51]).toBe('AZ');
    expect(refs[52]).toBe('BA');
    expect(refs[701]).toBe('ZZ');
    expect(refs[702]).toBe('AAA');
    expect(new Set(refs).size).toBe(width);
  });

  // [A13] (P2) an empty string is a (blank-looking) text cell, distinct from a null (no cell).
  it('empty string writes a text cell; null writes nothing', () => {
    const xml = parts(buildXlsx([{ name: 'S', rows: [['', null, 'x']] }]))['xl/worksheets/sheet1.xml'];
    expect(cells(xml).map((c) => c.ref)).toEqual(['A1', 'C1']);
    expect(cells(xml)[0]).toMatchObject({ inlineStr: true, text: '' });
  });
});
