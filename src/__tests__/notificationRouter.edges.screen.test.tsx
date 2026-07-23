// WHIT-321 — NotificationRouter adversarial gaps against the SINGLE-SOURCE
// (useLastNotificationResponse + id-dedup) implementation currently in the working tree.
// Covers crash-safety on undefined/malformed content.data and the malformed-type path
// through the component — none of which the implementer's screen test locks.
// NB: mocks ONLY useLastNotificationResponse (the working component uses no
// addNotificationResponseReceivedListener). See QA notes re: index vs working-tree drift.
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

describe('NotificationRouter — malformed / missing data (WHIT-321)', () => {
  it('[A25] a tap whose content.data is undefined does not crash and does not navigate', () => {
    mockLastResponse = responseWith(undefined);
    expect(() => render(<NotificationRouter />)).not.toThrow();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('[A26] a present-but-typeless data object does not navigate', () => {
    mockLastResponse = responseWith({ foo: 'bar' });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('[A27] a data.type that is null does not navigate (guard runs through the component)', () => {
    mockLastResponse = responseWith({ type: null });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('[A28] a data.type that is an array does not navigate', () => {
    mockLastResponse = responseWith({ type: ['repayment'] });
    render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('NotificationRouter — dedup is not defeated by a repayment tap (WHIT-321)', () => {
  it('[A29] the same tap re-surfacing after a malformed one still routes exactly once', () => {
    // A malformed tap first (no nav), then the real repayment tap with a NEW id → one nav;
    // re-render with the SAME repayment id → still one (id-dedup holds).
    mockLastResponse = responseWith({ type: 'nope' }, 'bad');
    const { rerender } = render(<NotificationRouter />);
    expect(mockPush).not.toHaveBeenCalled();

    mockLastResponse = responseWith({ type: 'repayment' }, 'good');
    rerender(<NotificationRouter />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/mortgage');

    rerender(<NotificationRouter />); // hook keeps returning the same response
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});
