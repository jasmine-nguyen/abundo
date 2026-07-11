// Reinsert `item` back into `list` in front of the first still-present id in
// `successorIds` — the ids that followed `item` when it was removed, nearest first. If none
// of them survive (they were also deleted) or the list ran out, append. WHIT-254.
//
// This replaces a saved integer index in the optimistic-delete rollbacks (deleteGoal /
// deleteRule). A saved index corrupts order when two deletes fail in the same tick: the
// second rollback splices against a list the first already mutated. Anchoring to a
// surviving successor's id restores the correct order for every interleaving, including two
// ADJACENT rows deleted together (a single-neighbour anchor would append one of them).
export function reinsertBefore<T extends { id: string }>(
  list: T[],
  item: T,
  successorIds: string[],
): T[] {
  const next = [...list];
  for (const id of successorIds) {
    const at = next.findIndex((x) => x.id === id);
    if (at !== -1) {
      next.splice(at, 0, item);
      return next;
    }
  }
  next.push(item);
  return next;
}
