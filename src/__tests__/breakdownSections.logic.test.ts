// ABU-68: a category saved with a bucket outside Living / Lifestyle / Income / Savings still shows,
// under UNCATEGORISED, instead of dropping out of the Insights list.
import { it, expect } from '@jest/globals';
import { bucketSections } from '../breakdownSections';
import type { Bucket } from '../types';

it('files a row with an unknown bucket under UNCATEGORISED, keeping its subs', () => {
  const rows = [
    { id: 'rent', depth: 0, bucket: 'Living' },
    { id: 'food', depth: 0, bucket: 'Essentials' },
    { id: 'coffee', depth: 1, bucket: 'Essentials' },
  ];
  const sections = bucketSections(rows, (r) => r.bucket as Bucket);

  expect(sections.map((s) => [s.heading, s.rows.map((r) => r.id)])).toEqual([
    ['LIVING', ['rent']],
    ['UNCATEGORISED', ['food', 'coffee']],
  ]);
});
