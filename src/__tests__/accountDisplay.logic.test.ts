// ABU-65: every per-account display rule lives in src/accountDisplay.ts so the Accounts tab and the
// account detail screen can't drift. The subtitle is a useful fact, not a count of loaded rows:
// cards → credit left; everyday → when money last went out; home loan → its payoff line.
import { it, expect, afterEach, jest } from '@jest/globals';
import { accountSubtitle, accountKind, orderAccounts, balanceDisplay, availableCredit, accountAccent } from '../accountDisplay';
import { C, ACCOUNT_ACCENTS } from '../theme';
import type { AccountBalance } from '../api';
import { pinToday } from './support/clock';
import { accountBalance as bal } from './support/accountBalance';
import { colourDifference, hueDegrees, type Vision } from './support/colourDifference';

const summary = (lastSpendDate: string | null) => ({ id: 'a1', name: 'Up Spending', count: 3, lastSpendDate });

afterEach(() => { jest.useRealTimers(); });

it.each([
  ['a card with credit left → credit available', summary('2026-10-16'), bal({ amount: -230, available_balance: 4549.4, account_type: 'unknown' }), null, '$4,549 available'],
  ['everyday, spent today', summary('2026-10-16'), bal({}), null, 'Last spend today'],
  ['everyday, spent yesterday', summary('2026-10-15'), bal({}), null, 'Last spend yesterday'],
  ['everyday, spent earlier', summary('2026-10-13'), bal({}), null, 'Last spend Tue 13 Oct'],
  ['everyday, nothing spent in the loaded rows', summary(null), bal({}), null, 'No recent spending'],
  ['home loan with a payoff line', summary('2026-10-16'), bal({ amount: -250000, available_balance: 0, account_type: 'mortgage' }), 'Next milestone: $50,000 to go', 'Next milestone: $50,000 to go'],
  ['home loan without a payoff plan', summary(null), bal({ amount: -250000, available_balance: 0, account_type: 'mortgage' }), null, 'Home loan · payoff inside'],
])('accountSubtitle: %s', (_name, s, b, loanLine, expected) => {
  pinToday(new Date(2026, 9, 16, 12, 0, 0));
  expect(accountSubtitle({ summary: s, bal: b, loanLine })).toBe(expected);
});

// [A1] Order is by type (card → everyday → loan → no balance yet), then name — never by input order.
it('orderAccounts: card, everyday, loan, then accounts with no balance yet; name breaks ties', () => {
  const s = (id: string, name: string) => ({ id, name, count: 1, lastSpendDate: null });
  const balances = new Map<string, AccountBalance>([
    ['loan', bal({ account_id: 'loan', account_type: 'mortgage' })],
    ['day', bal({ account_id: 'day', account_type: 'checking' })],
    ['visa', bal({ account_id: 'visa', account_type: 'unknown' })],
    ['amex', bal({ account_id: 'amex', account_type: 'unknown' })],
  ]);
  const input = [s('new', 'Aardvark Bank'), s('loan', 'Home'), s('day', 'Everyday'), s('visa', 'Visa'), s('amex', 'Amex')];
  expect(orderAccounts(input, balances).map((a) => a.id)).toEqual(['amex', 'visa', 'day', 'loan', 'new']);
  expect(accountKind(undefined)).toBe('unknown');
});

// [A2] Zero and money in stay C.good with no "owed"; only a negative balance is owed, minus sign dropped.
it.each([
  [0, '$0.00', C.good, false],
  [12.5, '$12.50', C.good, false],
  [-0.5, '$0.50', C.textBright, true],
])('balanceDisplay(%p)', (amount, text, color, owed) => {
  expect(balanceDisplay(amount)).toEqual({ text, color, owed });
});

// [A3] A maxed-out card (no credit left) or money in → no "available"; the subtitle falls back to last spend.
it('availableCredit is null for a maxed card or a positive balance; the card subtitle falls back to last spend', () => {
  pinToday(new Date(2026, 9, 16, 12, 0, 0));
  const maxed = bal({ amount: -5000, available_balance: 0, account_type: 'unknown' });
  expect(availableCredit(maxed)).toBeNull();
  expect(availableCredit(bal({ amount: 50, available_balance: 50 }))).toBeNull();
  expect(accountSubtitle({ summary: summary('2026-10-16'), bal: maxed, loanLine: null })).toBe('Last spend today');
});

// ABU-77: every pair of account colours must be easy to tell apart, for normal vision and both
// kinds of red-green colour blindness (CIEDE2000 gap; Machado 2009 simulation, full strength).
const accentPairs = ACCOUNT_ACCENTS.flatMap((a, i) => ACCOUNT_ACCENTS.slice(i + 1).map((b) => [a, b] as const));
const MIN_GAP: Record<Vision, number> = { normal: 20, protan: 10, deutan: 10 };

it.each(Object.entries(MIN_GAP) as [Vision, number][])('ACCOUNT_ACCENTS: every pair differs by at least the minimum gap (%s vision)', (vision, minGap) => {
  const tooClose = accentPairs
    .map(([a, b]) => ({ pair: `${a} vs ${b}`, gap: Math.round(colourDifference(a, b, vision) * 10) / 10 }))
    .filter(({ gap }) => gap < minGap);
  expect(tooClose).toEqual([]);
});

it('ACCOUNT_ACCENTS: no green, cyan or rose — those are the money colours', () => {
  const inMoneyHue = (h: number) => (h >= 75 && h <= 200) || h >= 330 || h <= 15;
  expect(ACCOUNT_ACCENTS.filter((hex) => inMoneyHue(hueDegrees(hex)))).toEqual([]);
});

it('accountAccent: each account keeps its slot in the colour list', () => {
  expect(accountAccent('a1')).toBe(C.accent);
  expect(accountAccent('visa-9912')).toBe(C.accountMagenta);
  expect(accountAccent('acc-up-spending')).toBe(C.warn);
});