// cafe-transaction-total-fix — exact-cents on the budget list rows + detail hero.
// Adversarial GAP coverage the implementer's tests don't reach: the INCOME earn-target
// branch with fractional earned on both screens, over-budget "over" with cents, penny +
// large-value + zero boundaries, and regression locks that the whole-dollar summary
// figures (pace copy, "of $X" target) stay whole. Fail-on-revert: each cents assertion
// breaks if fmtExact reverts to fmt (which rounds 73.50 → $74).
import { describe, it, expect } from '@jest/globals';
import { budgetViews, budgetDetail } from '../context';
import { fmt, fmtExact } from '../theme';
import { makeState, cat, budget } from './factory';

const income = (over = {}) => cat({ id: 'salary', name: 'Salary', color: '#35d9a0', bucket: 'Income', ...over });

// ── INCOME earn-target branch, fractional earned — list rows ──────────────────
// [A10] under target with cents: "earned"/"to go" figures carry the cents.
describe('budgetViews — income earn-target with fractional earned (GAP)', () => {
  const state = (posted: number, pending = 0, b = 5000) => makeState({
    categories: [income()], budgets: [budget({ id: 'salary', budget: b, posted, pending })],
    cycleLen: 14, daysLeft: 7, // elapsed 0.5 → target 2500
  });

  it('[A10] under target: earned + "to go" show exact cents, target stays whole', () => {
    const row = budgetViews(state(1000.25)).rows[0];
    expect(row.spentLabel).toBe('$1,000.25 earned of $5,000'); // fail-on-revert: fmt(1000.25) → '$1,000'
    expect(row.remainLabel).toBe('to go');
    expect(row.remainAmount).toBe('$3,999.75');                // 5000 - 1000.25; fmt would read '$4,000'
  });

  it('[A11] over target: the "over target" surplus shows exact cents', () => {
    const row = budgetViews(state(5006.5)).rows[0]; // earned 5006.50 ≥ 5000 floor
    expect(row.remainLabel).toBe('over target');
    expect(row.remainAmount).toBe('$6.50');                    // 5006.50 - 5000; fmt(6.5) rounds
    expect(row.spentLabel).toBe('$5,006.50 earned of $5,000');
  });

  it('[A12] pending folds into earned with cents (no separate breakout)', () => {
    const row = budgetViews(state(1000.25, 200.25)).rows[0];
    expect(row.spentLabel).toBe('$1,200.50 earned of $5,000'); // 1000.25 + 200.25
  });
});

// ── INCOME earn-target branch, fractional earned — detail hero ────────────────
describe('budgetDetail — income earn-target hero with cents (GAP)', () => {
  const detail = (posted: number, pending = 0) => budgetDetail(makeState({
    categories: [income()], budgets: [budget({ id: 'salary', budget: 5000, posted, pending })],
    cycleLen: 14, daysLeft: 7,
  }), 'salary')!;

  it('[A13] hero earned shows exact cents; "of $X" target stays whole', () => {
    const d = detail(1000.25);
    expect(d.spentBig).toBe('$1,000.25'); // fail-on-revert: fmt(1000.25) → '$1,000'
    expect(d.ofBudget).toBe('of $5,000'); // target is a whole-dollar summary — unchanged
  });

  it('[A14] met target hero: earned-past-floor still exact to the cent', () => {
    const d = detail(5006.5);
    expect(d.spentBig).toBe('$5,006.50');
    expect(d.statusLabel).toBe('Target reached — nice');
  });
});

// ── OVER-BUDGET spend row: the "over" amount with cents ───────────────────────
describe('budgetViews / budgetDetail — over-budget spend with cents (GAP)', () => {
  const over = () => makeState({
    categories: [cat()], budgets: [budget({ id: 'coffee', budget: 80, posted: 90.25, pending: 0 })],
    cycleLen: 14, daysLeft: 7,
  });

  it('[A15] list row: spent + "over" figures carry cents', () => {
    const row = budgetViews(over()).rows[0];
    expect(row.over).toBe(true);
    expect(row.spentLabel).toBe('$90.25 spent of $80'); // fail-on-revert: fmt(90.25) → '$90'
    expect(row.remainLabel).toBe('over');
    expect(row.remainAmount).toBe('$10.25');            // unsigned |80 - 90.25|; fmt would read '$10'
    // FINDING: the "over budget" pace ARM was ALSO switched to fmtExact on this branch
    // (context.tsx:1789), so it now shows cents too. That CONTRADICTS the card's
    // "pace/daily projections intentionally unchanged". Asserting the AS-BUILT value here so
    // this stays a live fail-on-revert lock; the deviation is raised in the critique for a call.
    expect(row.paceLabel).toBe('$10.25 over budget');   // was '$10 over budget' on main
  });

  it('[A15b] REGRESSION: the over-PACE arm (not over budget) still renders whole-dollar', () => {
    // budget 100, elapsed 0.5 → target 50. spent 60.25 is over PACE (>50) but under budget (<100),
    // so it hits the `spent - target` arm, which stayed on fmt. Guards that only the over-budget
    // arm changed — this one must NOT sprout cents ('$10 over pace', not '$10.25').
    const row = budgetViews(makeState({ categories: [cat()], budgets: [budget({ id: 'coffee', budget: 100, posted: 60.25, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.over).toBe(false);
    expect(row.paceLabel).toBe('$10 over pace');         // fmt arm — whole-dollar, unchanged
    expect(row.spentLabel).toBe('$60.25 spent of $100'); // spent figure still exact
    expect(row.remainAmount).toBe('$39.75');             // 100 - 60.25
  });

  it('[A16] detail hero: over-budget spentBig is exact to the cent', () => {
    const d = budgetDetail(over(), 'coffee')!;
    expect(d.spentBig).toBe('$90.25');
    expect(d.statusLabel).toBe('Over budget — ease up');
  });
});

// ── Boundaries: penny, large value, exactly zero ─────────────────────────────
describe('budgetViews — cents boundaries (GAP)', () => {
  const spendState = (posted: number, pending = 0, b = 100) => makeState({
    categories: [cat()], budgets: [budget({ id: 'coffee', budget: b, posted, pending })],
    cycleLen: 14, daysLeft: 7,
  });

  it('[A17] a single penny is visible, not swallowed to $0', () => {
    const row = budgetViews(spendState(0.01)).rows[0];
    expect(row.spentLabel).toBe('$0.01 spent of $100'); // fail-on-revert: fmt(0.01) → '$0'
    expect(row.remainAmount).toBe('$99.99');
  });

  it('[A18] a large spend keeps the thousands separator AND the cents', () => {
    const row = budgetViews(spendState(1234.5, 0, 2000)).rows[0];
    expect(row.spentLabel).toBe('$1,234.50 spent of $2,000');
    expect(row.remainAmount).toBe('$765.50'); // 2000 - 1234.50
  });

  it('[A19] exactly-zero spend reads a bare "$0" (no phantom ".00")', () => {
    const row = budgetViews(spendState(0)).rows[0];
    expect(row.spentLabel).toBe('$0 spent of $100');
    expect(row.remainAmount).toBe('$100');
  });
});

// ── Regression: whole-dollar cases must be byte-for-byte unchanged ────────────
describe('exact-cents change leaves whole-dollar labels untouched (regression)', () => {
  it('[A20] whole spend row unchanged', () => {
    const row = budgetViews(makeState({ categories: [cat()], budgets: [budget({ budget: 100, posted: 40, pending: 10 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.spentLabel).toBe('$50 spent of $100');
    expect(row.remainAmount).toBe('$50');
  });

  it('[A21] whole income remain ("to go") unchanged', () => {
    const row = budgetViews(makeState({ categories: [income()], budgets: [budget({ id: 'salary', budget: 5000, posted: 1000, pending: 0 })], cycleLen: 14, daysLeft: 7 })).rows[0];
    expect(row.remainAmount).toBe('$4,000');
    expect(row.spentLabel).toBe('$1,000 earned of $5,000');
  });

  it('[A22] the raw fmt token for these values would round — proving the labels genuinely exercise cents', () => {
    // Guards the fail-on-revert direction: fmt collapses each cent-bearing value the rows show.
    expect(fmt(73.5)).toBe('$74');
    expect(fmt(90.25)).toBe('$90');
    expect(fmt(0.01)).toBe('$0');
    expect(fmtExact(73.5)).toBe('$73.50'); // and fmtExact does not
  });
});
