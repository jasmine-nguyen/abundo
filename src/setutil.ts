// A new Set with `id` added if missing, removed if present. Never mutates `prev`, so it is safe
// as a React state updater.
export function toggleIn<T>(prev: Set<T>, id: T): Set<T> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

// The rows of a depth-first tree (parent before child) whose whole parent chain is open.
export function visibleTreeRows<R extends { parentId: string | null }>(rows: R[], idOf: (row: R) => string, isOpen: (id: string) => boolean): R[] {
  const shown = new Set<string>();
  for (const row of rows) {
    if (row.parentId === null || (shown.has(row.parentId) && isOpen(row.parentId))) shown.add(idOf(row));
  }
  return rows.filter((row) => shown.has(idOf(row)));
}
