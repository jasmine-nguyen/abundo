import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData } from '../notificationRouting';

describe('routeForNotificationData (WHIT-321, WHIT-322)', () => {
  it.each([
    ['repayment', { type: 'repayment' }, '/mortgage'],
    ['milestone', { type: 'milestone' }, '/milestone'],
    ['goal', { type: 'goal' }, '/goals'],
    ['goalcheckpoint (WHIT-479 push)', { type: 'goalcheckpoint', goalId: 'g1' }, '/goals'],
    ['budget with a category', { type: 'budget', category: 'groceries' }, '/budget/groceries'],
  ])('maps a %s notification to its screen', (_name, data, route) => {
    expect(routeForNotificationData(data)).toBe(route);
  });

  // A malformed push must never navigate.
  it.each([
    ['data missing', undefined],
    ['data null', null],
    ['data a string', 'repayment'],
    ['data a number', 42],
    ['data an empty array', []],
    ['data an array', ['repayment']],
    ['type absent', {}],
    ['type null', { type: null }],
    ['type a number', { type: 123 }],
    ['type an array', { type: ['repayment'] }],
    ['type an object', { type: { name: 'repayment' } }],
    ['type a boolean', { type: true }],
    ['type an empty string', { type: '' }],
    ['type unmapped', { type: 'nope' }],
    ['budget with no category', { type: 'budget' }],
    ['budget with an empty category', { type: 'budget', category: '' }],
    ['budget with a number category', { type: 'budget', category: 123 }],
    ['budget with a null category', { type: 'budget', category: null }],
    ['budget with a boolean category', { type: 'budget', category: true }],
    ['budget with an object category', { type: 'budget', category: { id: 'x' } }],
    ['budget with an array category', { type: 'budget', category: ['x'] }],
    ['budget with a 0 category', { type: 'budget', category: 0 }],
  ])('returns null when %s', (_name, data) => {
    expect(routeForNotificationData(data)).toBeNull();
  });
});
