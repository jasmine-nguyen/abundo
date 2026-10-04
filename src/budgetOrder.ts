import type { BudgetView } from './context';

// WHIT-727: the Budgets tab lists spending families (a row and its budgeted sub-rows) by
// their most urgent row — over budget, then behind pace, then the rest — keeping category
// order within each rank. Earning rows stay last, unchanged.
function urgency(row: BudgetView): number {
  if (row.over) return 0;
  if (row.behindPace) return 1;
  return 2;
}

export function urgentFirst(rows: BudgetView[]): BudgetView[] {
  const families: BudgetView[][] = [];
  for (const row of rows) {
    if (row.section !== 'spending') continue;
    const current = families[families.length - 1];
    if (row.depth === 0 || !current || !current.some((r) => r.id === row.parentId)) {
      families.push([row]);
      continue;
    }
    current.push(row);
  }
  const spending = families
    .map((family) => ({ family, rank: Math.min(...family.map(urgency)) }))
    .sort((a, b) => a.rank - b.rank)
    .flatMap(({ family }) => family);
  return [...spending, ...rows.filter((r) => r.section === 'earning')];
}
