// WHIT-700: write a cycle's CSV to a file and open the phone's share menu. Kept apart from
// cycleExport.ts so the logic tests never load the native file and share modules.
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { fetchCycleTransactions } from './api';
import { buildCycleCsv, cycleCsvFileName } from './cycleExport';
import type { Category } from './types';

export async function shareCycleCsv(
  cycle: number,
  category: (id: string) => Category | undefined,
): Promise<void> {
  const { start, end, transactions } = await fetchCycleTransactions(cycle);
  const file = new File(Paths.cache, cycleCsvFileName(start, end));
  file.create({ overwrite: true });
  file.write(buildCycleCsv(transactions, category));
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: 'Export transactions',
  });
}
