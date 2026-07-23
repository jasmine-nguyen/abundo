import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData, NOTIF_ROUTE, NOTIF_ROUTE_BUILDERS } from '../notificationRouting';

describe('routeForNotificationData (WHIT-321, WHIT-322)', () => {
  it('maps a repayment notification to the mortgage screen', () => {
    expect(routeForNotificationData({ type: 'repayment' })).toBe('/mortgage');
  });

  it('maps a milestone notification to the mortgage screen', () => {
    expect(routeForNotificationData({ type: 'milestone' })).toBe('/mortgage');
  });

  it('maps a goal notification to the goals screen', () => {
    expect(routeForNotificationData({ type: 'goal' })).toBe('/goals');
  });

  it('maps a budget notification to that category’s budget screen', () => {
    expect(routeForNotificationData({ type: 'budget', category: 'groceries' })).toBe('/budget/groceries');
  });

  it('returns null for a budget notification with a missing/empty category', () => {
    expect(routeForNotificationData({ type: 'budget' })).toBeNull();
    expect(routeForNotificationData({ type: 'budget', category: '' })).toBeNull();
    expect(routeForNotificationData({ type: 'budget', category: 123 })).toBeNull();
  });

  it('has the expected static routes in the table', () => {
    expect(NOTIF_ROUTE.repayment).toBe('/mortgage');
    expect(NOTIF_ROUTE.milestone).toBe('/mortgage');
    expect(NOTIF_ROUTE.goal).toBe('/goals');
  });

  it('exposes a budget route builder (not a static route)', () => {
    expect(NOTIF_ROUTE.budget).toBeUndefined();
    expect(typeof NOTIF_ROUTE_BUILDERS.budget).toBe('function');
  });

  it('returns null for an unmapped type', () => {
    expect(routeForNotificationData({ type: 'nope' })).toBeNull();
  });

  it('returns null when data is missing or not an object', () => {
    expect(routeForNotificationData(undefined)).toBeNull();
    expect(routeForNotificationData(null)).toBeNull();
    expect(routeForNotificationData('repayment')).toBeNull();
    expect(routeForNotificationData(42)).toBeNull();
  });

  it('returns null when type is absent or not a string', () => {
    expect(routeForNotificationData({})).toBeNull();
    expect(routeForNotificationData({ type: 123 })).toBeNull();
  });
});
