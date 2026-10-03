// WHIT-703: a minimal Excel (.xlsx) writer — an .xlsx is a zip of a few XML files.
// Pure JS on fflate (no native code), so it ships in an over-the-air update.
// Strings are stored inline; numbers use the built-in 2-decimal format (numFmtId 2).
import { strToU8, zipSync } from 'fflate';

export type Cell = string | number | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TWO_DECIMALS_STYLE = 1;

function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function cellXml(cell: Cell, ref: string): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return `<c r="${ref}" s="${TWO_DECIMALS_STYLE}"><v>${cell}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
}

function sheetXml(rows: Cell[][]): string {
  const rowsXml = rows.map((cells, r) => {
    const cellsXml = cells.map((cell, c) => cellXml(cell, `${columnName(c)}${r + 1}`)).join('');
    return `<row r="${r + 1}">${cellsXml}</row>`;
  }).join('');
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

function contentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + `${sheetOverrides}</Types>`;
}

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL_NS}">`
  + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>`
  + '</Relationships>';

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

function workbookXml(sheets: Sheet[]): string {
  const sheetsXml = sheets.map((sheet, i) =>
    `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  ).join('');
  return `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheetsXml}</sheets></workbook>`;
}

function workbookRelsXml(sheets: Sheet[]): string {
  const sheetRels = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('');
  const stylesRel = `<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>`;
  return `${XML_HEAD}<Relationships xmlns="${PACKAGE_REL_NS}">${sheetRels}${stylesRel}</Relationships>`;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml(sheets.length)),
    '_rels/.rels': strToU8(ROOT_RELS),
    'xl/workbook.xml': strToU8(workbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml(sheets)),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet.rows));
  });
  return zipSync(files);
}
