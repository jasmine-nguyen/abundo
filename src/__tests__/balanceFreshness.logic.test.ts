// WHIT-822 — the "As of <day>" balance pill's label and amber cut-off. Today/yesterday and the
// UTC-evening case are drawn on screen in mortgageMilestoneEquityPace.screen.test.tsx.
import { it, expect } from '@jest/globals';
import { balanceFreshness } from '../dateutil';

const NOW = new Date(2026, 9, 8, 12); // 8 Oct 2026, midday local

it.each<[string, string | null, { label: string; stale: boolean } | null]>([
  ['a date-only balance 3 days old: its local day, still fresh', '2026-10-05', { label: 'As of 5 Oct', stale: false }],
  ['4 days old turns amber', '2026-10-04', { label: 'As of 4 Oct', stale: true }],
  ['no date', null, null],
  ['an unparseable date', 'not a date', null],
])('balance freshness: %s', (_case, asOf, expected) => {
  expect(balanceFreshness(asOf, NOW)).toEqual(expected);
});
