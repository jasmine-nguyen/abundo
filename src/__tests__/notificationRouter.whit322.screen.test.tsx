// WHIT-322 — NotificationRouter end-to-end for the THREE new push types (milestone, goal,
// budget). The implementer's screen test only exercises repayment; these prove the component
// actually navigates to the right screen for each new type through the real
// routeForNotificationData (not a re-implemented map), and that a budget tap with no category
// foregrounds without navigating.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render } from '@testing-library/react-native';
import { NotificationRouter } from '../components/NotificationRouter';

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

describe('NotificationRouter — new deep-link types (WHIT-322)', () => {
  it('[A40] a milestone tap navigates to /milestone', () => {
    mockLastResponse = responseWith({ type: 'milestone' });
    render(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledWith('/milestone');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('[A41] a goal tap navigates to /goals', () => {
    mockLastResponse = responseWith({ type: 'goal' });
    render(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledWith('/goals');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('[A42] a budget tap carrying a category navigates to that category screen', () => {
    mockLastResponse = responseWith({ type: 'budget', category: 'groceries' });
    render(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledWith('/budget/groceries');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('[A43] a budget tap with a MISSING category does not navigate (just foregrounds)', () => {
    mockLastResponse = responseWith({ type: 'budget' });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('[A44] a budget tap with an empty-string category does not navigate', () => {
    mockLastResponse = responseWith({ type: 'budget', category: '' });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });
});
