// WHIT-718 — the sample categories the screen tests seed (coffee, groceries, subs) live once, in
// support/categories.ts. Every other test file imports them instead of spelling them out.
import { describe, it, expect } from '@jest/globals';
import { COFFEE, COFFEE_RECORD, GROCERIES, SUBS } from './support/categories';
import { findOffenders } from './support/sourceScan';
import { cat } from './factory';

const HOME = 'support/categories.ts';

// Built from pieces so this file never matches its own scan.
const q = (text: string) => `'${text}'`;
const COPIES = [
  `name: ${q('Cafes & Coffee')}, bucket: ${q('Lifestyle')}, icon: ${q('coffee')}`,
  `color: ${q('#7fd49b')}, recent: ` + '100',
  `${q('subs')}, name: ${q('Subs')}, bucket: ${q('Lifestyle')}, icon: ${q('film')}`,
  `${q('groceries')}, name: ${q('Groceries')}, bucket: ${q('Living')}, icon: ${q('cart')}, parent: null }`,
];
// The WHIT-719 guard checks the groceries row's exact values, so it spells one out on purpose.
const EXACT_VALUE_CHECKS = ['whit719GroceriesTopOneHome.logic.test.ts'];

describe('the shared category samples have one home', () => {
  it('support/categories exports the coffee, groceries and subs samples, and cat() defaults to coffee', () => {
    expect(COFFEE_RECORD).toEqual({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee' });
    expect(COFFEE).toEqual({ id: 'coffee', name: 'Cafes & Coffee', bucket: 'Lifestyle', icon: 'coffee', color: '#E8A87C', recent: 52 });
    expect(GROCERIES).toEqual({ id: 'groceries', name: 'Groceries', bucket: 'Living', icon: 'cart', color: '#7fd49b', recent: 100 });
    expect(SUBS).toEqual({ id: 'subs', name: 'Subs', bucket: 'Lifestyle', icon: 'film', color: '#f0b27a', recent: 0 });
    expect(Object.isFrozen(COFFEE)).toBe(true);
    expect(cat()).toEqual(COFFEE);
  });

  it('no other test file spells out a copy of those samples', () => {
    const offenders = findOffenders((line) => COPIES.some((copy) => line.includes(copy)), new Set([HOME, 'whit718CategorySamplesOneHome.logic.test.ts', ...EXACT_VALUE_CHECKS]));
    expect(offenders).toEqual([]);
  });
});
