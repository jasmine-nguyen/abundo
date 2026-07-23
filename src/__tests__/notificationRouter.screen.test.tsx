import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { NotificationRouter } from '../components/NotificationRouter';

// `useLastNotificationResponse` is the single source of taps (warm + cold). The tests drive
// it via mockLastResponse. All factory-referenced state is `mock`-prefixed (jest hoist rule)
// and only read inside the mocked functions, which run at render time.
const mockPush = jest.fn();
let mockNavState: { key?: string } | null = { key: 'root' };
let mockLastResponse: unknown = null;

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRootNavigationState: () => mockNavState,
}));

jest.mock('expo-notifications', () => ({
  useLastNotificationResponse: () => mockLastResponse,
}));

const responseWith = (data: unknown, identifier = 'n1') => ({
  notification: { request: { identifier, content: { data } } },
});

beforeEach(() => {
  mockPush.mockClear();
  mockNavState = { key: 'root' };
  mockLastResponse = null;
});

describe('NotificationRouter (WHIT-321)', () => {
  it('navigates to /mortgage for a repayment tap', () => {
    mockLastResponse = responseWith({ type: 'repayment' });
    render(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledWith('/mortgage');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unmapped notification type', () => {
    mockLastResponse = responseWith({ type: 'nope' });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does nothing when there is no tap response', () => {
    mockLastResponse = null;
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('waits for the navigator: no nav while root state is null, then navigates once ready', () => {
    mockNavState = null; // navigator not mounted yet
    mockLastResponse = responseWith({ type: 'repayment' });
    const { rerender } = render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();

    mockNavState = { key: 'root' }; // navigator mounts
    rerender(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('navigates only once for the same tap across re-renders (the hook returns it repeatedly)', () => {
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-1');
    const { rerender } = render(<NotificationRouter />);
    rerender(<NotificationRouter />);
    rerender(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('navigates again for a distinct later tap (repeated warm taps each route)', () => {
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-1');
    const { rerender } = render(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledTimes(1);

    // A second, different repayment tap while the app runs → navigate again.
    mockLastResponse = responseWith({ type: 'repayment' }, 'tap-2');
    rerender(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledTimes(2);
  });
});
