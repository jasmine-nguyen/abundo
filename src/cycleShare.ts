// WHIT-700 / WHIT-703: write a cycle's Excel workbook to a file and open the phone's share
// menu. Kept apart from cycleExport.ts so the logic tests never load the native modules.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { fetchCycleTransactions } from './api';
import { buildCycleWorkbook, cycleFileName } from './cycleExport';
import type { Category } from './types';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLSX_UTI = 'org.openxmlformats.spreadsheetml.sheet';

export async function shareCycleExport(
  cycle: number,
  category: (id: string) => Category | undefined,
): Promise<void> {
  const data = await fetchCycleTransactions(cycle);
  const file = new File(Paths.cache, cycleFileName(data.start, data.end));
  file.create({ overwrite: true });
  file.write(buildCycleWorkbook(data, category, cycle > 0));
  await Sharing.shareAsync(file.uri, {
    mimeType: XLSX_MIME_TYPE,
    UTI: XLSX_UTI,
    dialogTitle: 'Export transactions',
  });
}
