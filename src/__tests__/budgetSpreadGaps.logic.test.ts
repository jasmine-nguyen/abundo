// WHIT-505 — bill-spread view-math GAP tests (adversarial half; happy path lives in
// budgetSpread.logic.test.ts). Covers the boundaries the implementer's suite skips:
// a payback slice bigger than the base budget (negative envelope), a huge cushion,
// spreadPreview at cycles=1/24/sub-cent, the spreadLine deadband, the over/canStartSpread
// boundaries, and toBudget's spread object passthrough identity.
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail, toBudget, spreadPreview } from '../context';
import { makeState, cat, budget } from './factory';

const sink = (over = {}) => cat({ id: 'sink', name: 'Sink', bucket: 'Lifestyle', ...over });
const state = (b: object) => makeState({
  categories: [sink()], budgets: [budget({ id: 'sink', ...b })], cycleLen: 14, daysLeft: 7,
});
const detail = (b: object, category = sink()) => budgetDetail(makeState({
  categories: [category], budgets: [budget({ id: 'sink', ...b })], cycleLen: 14, daysLeft: 7,
}), 'sink')!;

// ── negative / extreme envelope stays finite (den guard + adjustment fold) ────
describe('budgetViews/budgetDetail — extreme spread envelope', () => {
  // [G1] A payback slice LARGER than the base budget drives available negative even at $0
  // spent. The den guard must keep the bar percentage finite (no NaN/Infinity) and the row
  // must read `over`. Fail-on-revert: dropping `+ b.spreadAdjustment` leaves available=100 → over false.
  it('[G1] a payback bigger than the budget → negative envelope, finite bars, reads over', () => {
    const row = budgetViews(state({
      budget: 100, posted: 0, pending: 0, spreadAdjustment: -150,
      spread: { amount: 3600, cycles: 24, index: 5, adjustment: -150 },
    })).rows[0];
    expect(row.over).toBe(true);                 // available = 100 - 150 = -50 < spent 0
    expect(Number.isFinite(row.postedPct)).toBe(true);
    expect(row.postedPct).toBe(0);               // posted 0 / den(fallback 100)
    expect(row.remainAmount).toBe('$50');        // fmtExact(-50)

    const d = detail({
      budget: 100, posted: 0, pending: 0, spreadAdjustment: -150,
      spread: { amount: 3600, cycles: 24, index: 5, adjustment: -150 },
    });
    expect(d.statusLabel).toBe('Over budget — ease up');
    expect(Number.isFinite(d.postedPct)).toBe(true);
    expect(d.spentBig).toBe('$0');               // not "$NaN"
  });

  // [G2] A cushion far bigger than spend must clamp the posted bar to <=100, never overflow.
  it('[G2] a huge cushion clamps postedPct to <= 100', () => {
    const row = budgetViews(state({
      budget: 100, posted: 40, pending: 0, spreadAdjustment: 100000,
      spread: { amount: 100000, cycles: 3, index: 0, adjustment: 100000 },
    })).rows[0];
    expect(row.postedPct).toBeGreaterThanOrEqual(0);
    expect(row.postedPct).toBeLessThanOrEqual(100);
    expect(row.over).toBe(false);
  });
});

// ── spreadPreview boundary splits ────────────────────────────────────────────
describe('spreadPreview — cycle-count boundaries', () => {
  // [G3] cycles=1 → the whole amount is a single slice equal to the cushion.
  it('[G3] cycles=1 pays the whole amount back in one slice', () => {
    const p = spreadPreview(100, 1);
    expect(p.cushion).toBe(100);
    expect(p.firstSlice).toBe(100);
    expect(p.lastSlice).toBe(100);
  });

  // [G4] cycles=24 (the SPREAD_MAX_CYCLES bound): 10000c / 24 = 416 base, 16 extra cents on
  // the earliest slices. Fail-on-revert: dropping the `extra` carry makes first==last==4.16.
  it('[G4] cycles=24 carries the odd cents onto the earliest slices', () => {
    const p = spreadPreview(100, 24);
    expect(p.firstSlice).toBe(4.17);
    expect(p.lastSlice).toBe(4.16);
    // The slices must still reconcile to the whole amount: 16*4.17 + 8*4.16 = 100.
    expect(16 * p.firstSlice + 8 * p.lastSlice).toBeCloseTo(100, 10);
  });

  // [G5] A sub-cent-per-slice amount: 1 cent over 3 cycles — one slice gets the cent, the
  // rest get nothing. The preview must not go negative or NaN.
  it('[G5] a 1-cent bill over 3 cycles gives one 1c slice and zero others', () => {
    const p = spreadPreview(0.01, 3);
    expect(p.cushion).toBe(0.01);
    expect(p.firstSlice).toBe(0.01);
    expect(p.lastSlice).toBe(0);
  });
});

// ── spreadLine deadband ──────────────────────────────────────────────────────
describe('budgetDetail — spreadLine deadband', () => {
  // [G6] A plan whose adjustment reconciles to zero (|adj| <= 0.005, incl. exactly 0) shows
  // NO status line, though the plan is still active. Fail-on-revert: relaxing `adj > 0.005`
  // to `adj > 0` makes the +0.004 case emit a "+$0.01 added" line.
  it('[G6] |adjustment| within a half-cent shows no status line (still active)', () => {
    const tinyPos = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: 0.004, spread: { amount: 12, cycles: 3, index: 3, adjustment: 0.004 } });
    expect(tinyPos.spreadLine).toBe('');
    expect(tinyPos.spreadActive).toBe(true);

    const tinyNeg = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: -0.004, spread: { amount: 12, cycles: 3, index: 3, adjustment: -0.004 } });
    expect(tinyNeg.spreadLine).toBe('');

    const zero = detail({ budget: 250, posted: 0, pending: 0, spreadAdjustment: 0, spread: { amount: 12, cycles: 3, index: 3, adjustment: 0 } });
    expect(zero.spreadLine).toBe('');
    expect(zero.spreadActive).toBe(true);
  });
});

// ── over / canStartSpread boundaries ─────────────────────────────────────────
describe('budgetDetail — over/spread boundaries', () => {
  // [G7] Spent EXACTLY at the budget is not "over" (strict >), so no spread is offered and
  // overspend is 0. Fail-on-revert: `spent > available` → `spent >= available` flips this.
  it('[G7] spent exactly equal to budget is not over → no spread offered, overspend 0', () => {
    const d = detail({ budget: 100, posted: 100, pending: 0 });
    expect(d.canStartSpread).toBe(false);
    expect(d.overspend).toBe(0);
    expect(d.spreadActive).toBe(false);
  });

  // [G8] A cushion that EXACTLY equals the overspend lands available == spent → over is false
  // (boundary), and the plan is still reachable via spreadActive (decision 2).
  it('[G8] a cushion exactly equal to the overspend flips over false, keeps the plan reachable', () => {
    const d = detail({ budget: 100, posted: 130, pending: 0, spreadAdjustment: 30, spread: { amount: 30, cycles: 3, index: 0, adjustment: 30 } });
    expect(d.statusLabel).not.toBe('Over budget — ease up');   // available 130 == spent 130
    expect(d.spreadActive).toBe(true);
    expect(d.canStartSpread).toBe(false);                       // already has a plan
  });
});

// ── toBudget passthrough ─────────────────────────────────────────────────────
describe('toBudget — spread passthrough identity', () => {
  // [G9] The spread object is passed through by reference (the status line reads its
  // index/cycles). Fail-on-revert: dropping `spread: rollup.spread` yields undefined.
  it('[G9] passes the rollup.spread object through unchanged (same reference)', () => {
    const spread = { amount: 480, cycles: 6, index: 2, adjustment: -80 };
    const b = toBudget('x', { target: 200, posted: 0, pending: 0, spread });
    expect(b.spread).toBe(spread);
    expect(b.spreadAdjustment).toBe(-80);
  });
});
