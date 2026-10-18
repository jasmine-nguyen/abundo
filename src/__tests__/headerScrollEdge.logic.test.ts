// ABU-99: every page that draws the shared title bar (<Header>) above a scrolling list must switch
// on the title edge, so content scrolling under the title never looks half-cut. Fails if a page,
// or one of a page's scroll paths, is left out, now or in the future.
import { it, expect } from '@jest/globals';
import { shippedCode } from './support/sourceScan';

const TITLE_BAR = /<Header[\s/>]/;
const SCROLLER = /<(ScrollView|SectionList)\b/g;
const count = (code: string, pattern: RegExp) => (code.match(pattern) ?? []).length;

const headerPagesWithScroller = [...shippedCode()]
  .filter(([path, code]) => path.startsWith('app/') && TITLE_BAR.test(code) && count(code, SCROLLER) > 0);

it('every title-bar page with a scroller wires the scroll edge on each scroller', () => {
  expect(headerPagesWithScroller.map(([path]) => path)).toEqual(
    expect.arrayContaining(['app/transaction/[id].tsx', 'app/account/[id].tsx', 'app/settings.tsx', 'app/budget/edit.tsx']),
  );
  const missing = headerPagesWithScroller
    .filter(([, code]) =>
      count(code, SCROLLER) > count(code, /scrollProps\}/g)
      || !code.includes('useScrollEdge(')
      || !code.includes('divider='))
    .map(([path]) => path);
  expect(missing).toEqual([]);
});
