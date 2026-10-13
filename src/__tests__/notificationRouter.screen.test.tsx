import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { NotificationRouter } from '../components/NotificationRouter';
import { routerSpies, resetRouter } from './support/routerMock';

// `useLastNotificationResponse` is the single source of taps (warm + cold). The tests drive
// it via mockLastResponse. All factory-referenced state is `mock`-prefixed (jest hoist rule)
// and only read inside the mocked functions, which run at render time.
let mockNavState: { key?: string } | null = { key: 'root' };
let mockLastResponse: unknown = null;

jest.mock('expo-router', () => ({
  ...require('./support/routerMock').routerMockModule(),
  useRootNavigationState: () => mockNavState,
}));

jest.mock('expo-notifications', () => ({
  useLastNotificationResponse: () => mockLastResponse,
}));

const responseWith = (data: unknown, identifier = 'n1') => ({
  notification: { request: { identifier, content: { data } } },
});

beforeEach(() => {
  resetRouter();
  mockNavState = { key: 'root' };
  mockLastResponse = null;
});

describe('NotificationRouter (WHIT-321)', () => {
  it('navigates to /mortgage for a repayment tap', () => {
    mockLastResponse = responseWith({ type: 'repayment' });
    render(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledWith('/mortgage');
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
  });

  it('waits for the navigator: no nav while root state is null, then navigates once ready', () => {
    mockNavState = null; // navigator not mounted yet
    mockLastResponse = responseWith({ type: 'repayment' });
    const { rerender } = render(<NotificationRouter />);
    expect(routerSpies.push).not.toHaveBeenCalled();

    mockNavState = { key: 'root' }; // navigator mounts
    rerender(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
  });

  it('navigates only once for the same tap across re-renders (the hook returns it repeatedly)', () => {
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-1');
    const { rerender } = render(<NotificationRouter />);
    rerender(<NotificationRouter />);
    rerender(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
  });

  it('navigates again for a distinct later tap (repeated warm taps each route)', () => {
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-1');
    const { rerender } = render(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledTimes(1);

    // A second, different repayment tap while the app runs → navigate again.
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-2');
    rerender(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledTimes(2);
  });
});

// ===== WHIT-322 (folded from notificationRouter.whit322.screen.test.tsx) =====
// End-to-end for a built route: the component navigates to the budget screen through the real
// routeForNotificationData. Mock byte-identical to above.
describe('NotificationRouter — new deep-link types (WHIT-322)', () => {
  it('[A42] a budget tap carrying a category navigates to that category screen', () => {
    mockLastResponse = responseWith({ type: 'budget', category: 'groceries' });
    render(<NotificationRouter />);
    expect(routerSpies.push).toHaveBeenCalledWith('/budget/groceries');
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
  });
});
