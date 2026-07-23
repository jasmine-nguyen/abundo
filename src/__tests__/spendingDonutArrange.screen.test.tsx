// WHIT-323: the donut's warm/cool alternation — `temperature` (hue → warm/cool/neutral) and
// `arrangeByTemperature` (reorder so similar-hued slices are less likely to sit adjacent). Pure
// functions, but they live in SpendingDonut.tsx (RN imports), so this runs in the screen project.
import { describe, it, expect } from '@jest/globals';
import { temperature, arrangeByTemperature, type DonutSlice } from '../components/SpendingDonut';

const slice = (id: string, color: string, value = 100): DonutSlice => ({ id, name: id, color, value });
const temps = (arr: DonutSlice[]) => arr.map((s) => temperature(s.color));
// Count adjacent same-temperature pairs AROUND THE RING (wrap the last back to the first), ignoring
// the neutral Other slice — that's the thing alternation minimises.
const clashes = (arr: DonutSlice[]) => {
  const t = arr.map((s) => temperature(s.color)).filter((x) => x !== 'neutral');
  let n = 0;
  for (let i = 0; i < t.length; i++) if (t[i] === t[(i + 1) % t.length]) n++;
  return n;
};

describe('temperature', () => {
  it('classifies the warm categories (red / orange / gold / pink) as warm', () => {
    for (const hex of ['#ff9e64', '#e5495f', '#ff75a0', '#e0af68']) {
      expect(temperature(hex)).toBe('warm');
    }
  });

  it('classifies the cool categories (green / teal / blue / cyan / purple) as cool', () => {
    for (const hex of ['#9ece6a', '#73daca', '#7aa2f7', '#2ac3de', '#bb9af7', '#9d7cd8']) {
      expect(temperature(hex)).toBe('cool');
    }
  });

  it('classifies the grey "Other" slice as neutral (low saturation)', () => {
    expect(temperature('#565f89')).toBe('neutral');
  });

  it('puts the yellow-green groceries on the cool side of the boundary (not warm)', () => {
    expect(temperature('#9ece6a')).toBe('cool'); // hue ~89°, just past the 80° warm cutoff
  });
});

describe('arrangeByTemperature', () => {
  it('perfectly alternates a balanced 3-warm / 3-cool ring', () => {
    const input = [
      slice('health', '#ff75a0'), slice('eatingout', '#e5495f'), slice('coffee', '#ff9e64'),
      slice('shopping', '#73daca'), slice('transport', '#7aa2f7'), slice('groceries', '#9ece6a'),
    ];
    const out = arrangeByTemperature(input);
    expect(temps(out)).toEqual(['warm', 'cool', 'warm', 'cool', 'warm', 'cool']);
    expect(clashes(out)).toBe(0); // no two same-temperature neighbours, wrap included
  });

  it('spreads the majority temperature on a lopsided ring (4 warm / 2 cool → minimal clashes)', () => {
    const input = [
      slice('coffee', '#ff9e64'), slice('eatingout', '#e5495f'), slice('health', '#ff75a0'),
      slice('utilities', '#e0af68'), slice('shopping', '#73daca'), slice('transport', '#7aa2f7'),
    ];
    const out = arrangeByTemperature(input);
    // Starts with the larger (warm) group and interleaves the two cools between them.
    expect(out.map((s) => s.id)).toEqual(['coffee', 'shopping', 'eatingout', 'transport', 'health', 'utilities']);
    // A circle with 4 warm + 2 cool can't avoid every warm-warm neighbour; 2 is the minimum.
    expect(clashes(out)).toBe(2);
  });

  it('places the neutral "Other" slice last', () => {
    const input = [
      slice('coffee', '#ff9e64'), slice('shopping', '#73daca'),
      slice('__other__', '#565f89', 40),
    ];
    const out = arrangeByTemperature(input);
    expect(out[out.length - 1].id).toBe('__other__');
  });

  it('preserves every slice and its value (only reorders)', () => {
    const input = [
      slice('health', '#ff75a0', 30), slice('coffee', '#ff9e64', 20),
      slice('shopping', '#73daca', 50), slice('__other__', '#565f89', 10),
    ];
    const out = arrangeByTemperature(input);
    expect(out.map((s) => s.id).sort()).toEqual(['__other__', 'coffee', 'health', 'shopping']);
    expect(out.reduce((n, s) => n + s.value, 0)).toBe(110);
  });

  it('is deterministic — the same input yields the same order', () => {
    const input = [slice('a', '#ff9e64'), slice('b', '#73daca'), slice('c', '#e5495f')];
    expect(arrangeByTemperature(input)).toEqual(arrangeByTemperature(input));
  });

  it('separates the two warm categories that used to clump, given cools to wedge between', () => {
    // The WHIT-323 case: Eating Out + Health (both warm). With TWO cools available, the ring can
    // fully separate them — on a circle, 2 warm + 1 cool can't (they'd stay wrap-adjacent), so the
    // real "not neighbours" guarantee needs a balanced set. clashes() counts circular adjacency.
    const input = [
      slice('eatingout', '#e5495f'), slice('health', '#ff75a0'),
      slice('shopping', '#73daca'), slice('transport', '#7aa2f7'),
    ];
    const out = arrangeByTemperature(input);
    expect(clashes(out)).toBe(0);                                      // no same-temperature neighbours, wrap included
    const iEat = out.findIndex((s) => s.id === 'eatingout');
    const iHealth = out.findIndex((s) => s.id === 'health');
    const ringGap = Math.min(Math.abs(iEat - iHealth), out.length - Math.abs(iEat - iHealth));
    expect(ringGap).toBeGreaterThan(1);                                // not adjacent even around the ring
  });
});
