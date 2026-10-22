// ABU-68 — the Insights Spending list groups its cards under bucket headings: LIVING, then LIFESTYLE,
// then UNCATEGORISED last. An opened parent keeps its subcategories (and its refund / adjustment
// lines) inside its own group. A group with no spend has no heading; the Earning side has none.
import { it, expect, jest, beforeEach } from '@jest/globals';
import { screen, fireEvent } from '@testing-library/react-native';
import { UNCATEGORIZED_KEY } from '../model';
import { ADJUSTMENT_ROW } from '../theme';
import { installFakeServer } from './support/fakeServer';
import { useTestQueryClient } from './support/renderWithQueries';
import { resetAuth } from './support/authMock';
import { breakdownWire, seedInsights, renderInsights, resetAi } from './support/insightsScreen';
import { DINING, GROCERIES_RECORD, MORTGAGE_RECORD, SALARY } from './support/categories';

jest.mock('../auth', () => require('./support/authMock').authMockModule());
jest.mock('../hooks/useAiInsights', () => require('./support/insightsScreen').useAiInsightsMockModule());
jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

const server = installFakeServer();
useTestQueryClient();

beforeEach(() => { resetAuth(); resetAi(); });

const posted = (n: number) => ({ posted: n, pending: 0 });
const HEADINGS = ['LIVING', 'LIFESTYLE', 'UNCATEGORISED'];

// A Living parent (Home) over Groceries + Mortgage, plus a refunded Living sub (Repairs).
const HOME = { id: 'home', name: 'Home', bucket: 'Living', icon: 'home', parent: null };
const REPAIRS = { id: 'repairs', name: 'Repairs', bucket: 'Living', icon: 'home', parent: 'home' };
const CATS = [HOME, { ...GROCERIES_RECORD, parent: 'home' }, { ...MORTGAGE_RECORD, parent: 'home' }, REPAIRS, DINING, SALARY];

// Every drawn string, in screen order.
function drawnTexts(): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    walk((node as { children?: unknown }).children);
  };
  walk(screen.toJSON());
  return out;
}

// The list comes after the pie, so a card's name is its last drawn copy.
function expectInOrder(labels: string[]) {
  const texts = drawnTexts();
  const at = labels.map((label) => texts.lastIndexOf(label));
  labels.forEach((label, i) => expect([label, at[i]]).not.toEqual([label, -1]));
  expect(at).toEqual([...at].sort((a, b) => a - b));
}

it('groups the spending cards under LIVING, LIFESTYLE then UNCATEGORISED, keeping an opened parent in its group', async () => {
  // Lifestyle (Dining $300) and Uncategorised ($500) outspend Living (Home $150), yet LIVING still leads.
  // Home's node $150 = Groceries 100 + Mortgage 40 + Repairs refund −15 + a $25 adjustment line.
  seedInsights(server, {
    breakdown: breakdownWire({
      spend: { groceries: posted(100), mortgage: posted(40), repairs: posted(0), dining: posted(300), [UNCATEGORIZED_KEY]: posted(500) },
      earned: 3000,
      income: { salary: posted(3000) },
      rollup: { nodes: { home: posted(150) }, refunds: { home: [{ id: 'repairs', amount: -15 }] } },
    }),
    categories: CATS,
  });
  await renderInsights();

  expectInOrder(['LIVING', 'Home', 'LIFESTYLE', 'Dining', 'UNCATEGORISED', 'Uncategorised']);
  expect(screen.queryByText('Groceries')).toBeNull();

  await fireEvent.press(screen.getByText('Home'));
  expectInOrder(['LIVING', 'Home', 'Groceries', 'LIFESTYLE']);
  expectInOrder(['Home', 'Mortgage', 'LIFESTYLE']);
  expectInOrder(['Home', 'Repairs', 'LIFESTYLE']);
  expectInOrder(['Home', ADJUSTMENT_ROW.name, 'LIFESTYLE', 'Dining']);

  await fireEvent.press(screen.getByText('Home'));
  expect(screen.queryByText('Groceries')).toBeNull();
  expectInOrder(['LIVING', 'Home', 'LIFESTYLE', 'Dining']);

  await fireEvent.press(screen.getByTestId('insights-side-earning'));
  expect(screen.getByText('Salary')).toBeTruthy();
  for (const heading of HEADINGS) expect(screen.queryByText(heading)).toBeNull();
});

it('shows a heading only for a group that has spend', async () => {
  seedInsights(server, {
    breakdown: breakdownWire({ spend: { groceries: posted(80), mortgage: posted(40) } }),
    categories: [GROCERIES_RECORD, MORTGAGE_RECORD],
  });
  await renderInsights();

  expectInOrder(['LIVING', 'Groceries', 'Mortgage']);
  expect(screen.getByText('LIVING')).toHaveProp('accessibilityRole', 'header');
  expect(screen.queryByText('LIFESTYLE')).toBeNull();
  expect(screen.queryByText('UNCATEGORISED')).toBeNull();
});
