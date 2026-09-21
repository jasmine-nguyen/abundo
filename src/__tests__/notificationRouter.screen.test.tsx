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

// ===== WHIT-321 (folded from notificationRouter.edges.screen.test.tsx) =====
// Adversarial gaps: crash-safety on undefined/malformed content.data and the malformed-type
// path through the component. Mocks ONLY useLastNotificationResponse (the working component
// uses no addNotificationResponseReceivedListener) — byte-identical to the mock hoisted above.
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

// ===== WHIT-322 (folded from notificationRouter.whit322.screen.test.tsx) =====
// End-to-end for the THREE new push types (milestone, goal, budget): the component navigates
// to the right screen for each new type through the real routeForNotificationData, and a
// budget tap with no category foregrounds without navigating. Mock byte-identical to above.
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
