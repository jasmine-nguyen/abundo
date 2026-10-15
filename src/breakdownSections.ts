import { BUCKETS } from './context';
import type { Bucket } from './types';

// ABU-68: split the visible breakdown rows (depth-first) into bucket sections, in BUCKETS order,
// with the no-bucket (Uncategorised) section last. A row joins its nearest top-level row's
// section, so an opened parent's subs, refund and "Other" lines stay in its group.
export function bucketSections<R extends { depth: number }>(rows: R[], bucketOf: (row: R) => Bucket | null) {
  const byBucket = new Map<Bucket | null, R[]>();
  let current: R[] = [];
  for (const row of rows) {
    if (row.depth === 0) {
      const bucket = bucketOf(row);
      current = byBucket.get(bucket) ?? [];
      byBucket.set(bucket, current);
    }
    current.push(row);
  }
  return [...BUCKETS, null]
    .filter((bucket) => byBucket.has(bucket))
    .map((bucket) => ({
      key: bucket ?? 'uncategorised',
      heading: bucket ? bucket.toUpperCase() : 'UNCATEGORISED',
      rows: byBucket.get(bucket) as R[],
    }));
}
