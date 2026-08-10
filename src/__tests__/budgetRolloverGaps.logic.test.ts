// Budget ROLLOVER — adversarial GAP coverage (QA, budget-rollover feature).
// Complements budgetRollover.logic.test.ts (the implementer's happy-path view math). Here:
//   * setBudget() wire body: `rollover` OMITTED when the caller doesn't pass it (a plain
//     amount edit must not touch the stored flag), INCLUDED as true AND as false when passed.
//   * the carryover chip/line DEADBAND at |0.5|: exactly on the threshold shows nothing; just
//     past it shows the chip. (The buffer still shifts `available`; only the label is gated.)
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../auth', () => ({ getAuthToken: jest.fn<() => Promise<string | undefined>>() }));
import { getAuthToken } from '../auth';
import { setBudget } from '../api';
import { budgetViews, budgetDetail } from '../context';
import { makeState, cat, budget } from './factory';

const mockGetAuthToken = getAuthToken as jest.MockedFunction<typeof getAuthToken>;
const API = 'https://xlja6cpdbf.execute-api.ap-southeast-2.amazonaws.com';

function okJson(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
let fetchMock: jest.Mock;

beforeEach(() => {
  mockGetAuthToken.mockReset().mockResolvedValue('test-token');
  fetchMock = jest.fn();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

// ── setBudget wire body ──────────────────────────────────────────────────────
describe('setBudget — rollover in the request body', () => {
  it('OMITS rollover when the caller does not pass it (leave the stored flag untouched)', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'coffee', target: 58 }));
    await setBudget('coffee', 58);
    const [url, opts] = fetchMock.mock.calls[0] as [string, any];
    expect(url).toBe(`${API}/budgets/coffee`);
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ target: 58 });
    expect('rollover' in body).toBe(false);  // NOT sent — an absent flag means "no change"
  });

  it('INCLUDES rollover: true when passed true', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'coffee', target: 58 }));
    await setBudget('coffee', 58, true);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body);
    expect(body).toEqual({ target: 58, rollover: true });
  });

  it('INCLUDES rollover: false when passed false (an explicit turn-off, not an omission)', async () => {
    fetchMock.mockReturnValue(okJson({ id: 'coffee', target: 58 }));
    await setBudget('coffee', 58, false);
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, any])[1].body);
    expect(body).toEqual({ target: 58, rollover: false });
    expect('rollover' in body).toBe(true);
  });
});

// ── carryover label deadband at |0.5| ────────────────────────────────────────
describe('carryover chip/line deadband (|value| must EXCEED 0.5 to show)', () => {
  const sink = cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle' });
  const rowFor = (carryover: number) =>
    budgetViews(makeState({
      categories: [sink], cycleLen: 14, daysLeft: 7,
      budgets: [budget({ id: 'sink', budget: 100, posted: 0, pending: 0, rollover: true, carryover })],
    })).rows[0];
  const detailFor = (carryover: number) =>
    budgetDetail(makeState({
      categories: [sink], cycleLen: 14, daysLeft: 7,
      budgets: [budget({ id: 'sink', budget: 100, posted: 0, pending: 0, rollover: true, carryover })],
    }), 'sink')!;

  it('exactly +0.5 shows no chip and no detail line (boundary is strict >)', () => {
    expect(rowFor(0.5).carryoverLabel).toBe('');
    expect(detailFor(0.5).carryoverLine).toBe('');
  });

  it('exactly -0.5 shows no chip (boundary is strict <)', () => {
    expect(rowFor(-0.5).carryoverLabel).toBe('');
  });

  it('just past +0.5 shows the rolled-over chip + line', () => {
    expect(rowFor(0.51).carryoverLabel.startsWith('+')).toBe(true);
    expect(rowFor(0.51).carryoverLabel).toContain('rolled over');
    expect(detailFor(0.51).carryoverLine).toContain('rolled over');
  });

  it('just past -0.5 shows the borrowed chip', () => {
    expect(rowFor(-0.51).carryoverLabel).toContain('borrowed');
  });
});
