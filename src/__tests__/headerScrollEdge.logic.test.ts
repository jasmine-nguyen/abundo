// ABU-99: every page that draws the shared title bar (<Header>) above a scrolling list must switch
// on the title edge, so content scrolling under the title never looks half-cut. Fails if a page,
// or one of a page's scroll paths, is left out, now or in the future.
import { it, expect } from '@jest/globals';
import { shippedCode } from './support/sourceScan';

const TITLE_BAR = /<Header[\s/>]/;
const SCROLLER = /<(ScrollView|SectionList)\b/g;
const count = (code: string, pattern: RegExp) => (code.match(pattern) ?? []).length;

const headerPagesWithScroller = [...shippedCode()]
  .filter(([path, code]) => (path.startsWith('app/') || path.startsWith('src/screens/')) && TITLE_BAR.test(code) && count(code, SCROLLER) > 0);

it('every title-bar page with a scroller wires the scroll edge on each scroller', () => {
  expect(headerPagesWithScroller.map(([path]) => path)).toEqual(
    expect.arrayContaining(['src/screens/TransactionDetailView.tsx','app/account/[id].tsx', 'app/settings.tsx', 'app/budget/edit.tsx']),
  );
  const missing = headerPagesWithScroller
    .filter(([, code]) =>
      // [A1] each scroll path has its own spread scroll props AND its own Header divider
      count(code, SCROLLER) > count(code, /scrollProps\}/g)
      || count(code, SCROLLER) > count(code, /divider=\{/g)
      || !code.includes('useScrollEdge('))
    .map(([path]) => path);
  expect(missing).toEqual([]);
});
