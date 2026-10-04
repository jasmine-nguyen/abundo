// WHIT-719 slice 2 — the Subscriptions sample the rules and add-rule tests seed (plain, and with its
// colour) lives once, in support/categories.ts. Every other test file imports it.
import { describe, it, expect } from '@jest/globals';
import { SUBSCRIPTIONS, SUBSCRIPTIONS_RECORD } from './support/categories';
import { findCopies, quoted } from './support/oneHomeGuard';

const COPIES = [
  `${quoted('subs')}, name: ${quoted('Subscriptions')}`,
  // The Rules screen's coffee is COFFEE_RECORD plus a colour, so it's a spread now too.
  `name: ${quoted('Cafes & Coffee')}, icon: ${quoted('coffee')}, color: ${quoted('#e8a87c')}`,
];

describe('the shared Subscriptions sample has one home', () => {
  it('support/categories exports Subscriptions with and without its colour, frozen', () => {
    expect(SUBSCRIPTIONS_RECORD).toEqual({ bucket: 'Lifestyle', icon: 'film', id: 'subs', name: 'Subscriptions' });
    expect(SUBSCRIPTIONS).toEqual({ bucket: 'Lifestyle', icon: 'film', id: 'subs', name: 'Subscriptions', color: '#f0b27a' });
    expect(Object.isFrozen(SUBSCRIPTIONS_RECORD)).toBe(true);
    expect(Object.isFrozen(SUBSCRIPTIONS)).toBe(true);
  });

  it('no other test file spells out a copy of Subscriptions or the Rules screen coffee', () => {
    expect(findCopies(COPIES, ['whit719SubscriptionsOneHome.logic.test.ts'])).toEqual([]);
  });
});
