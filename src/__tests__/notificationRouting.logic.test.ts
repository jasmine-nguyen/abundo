import { describe, it, expect } from '@jest/globals';
import { routeForNotificationData, NOTIF_ROUTE } from '../notificationRouting';

describe('routeForNotificationData (WHIT-321)', () => {
  it('maps a repayment notification to the mortgage screen', () => {
    expect(routeForNotificationData({ type: 'repayment' })).toBe('/mortgage');
  });

  it('has repayment -> /mortgage in the route table', () => {
    expect(NOTIF_ROUTE.repayment).toBe('/mortgage');
  });

  it('returns null for an unmapped type', () => {
    expect(routeForNotificationData({ type: 'budget' })).toBeNull();
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
