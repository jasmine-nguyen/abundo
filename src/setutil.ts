// A new Set with `id` added if missing, removed if present. Never mutates `prev`, so it is safe
// as a React state updater.
export function toggleIn<T>(prev: Set<T>, id: T): Set<T> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}
