// WHIT-144 — [A5][A6] the web guard on the foreground notification handler.
// push.ts wraps setNotificationHandler in `if (Platform.OS !== 'web')` so the native
// handler is NOT registered on web (where it has no meaning, mirroring
// registerForPushNotificationsAsync's web bail). The implementer's
// push.handler.screen.test.tsx only proves the NATIVE path (Platform.OS defaults to
// 'ios'); this adds the missing web-vs-native branch.
//
// The handler is a module-scope side effect that fires the instant '../push' is
// imported, so we can't just flip Platform.OS in a beforeEach — the import already
// happened. Instead we drive Platform.OS BEFORE each fresh module evaluation via
// jest.isolateModules(+resetModules), which re-runs push.ts (and its jest.mock
// factory, minting a fresh setNotificationHandler spy) under the OS we set.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));
jest.mock('../api', () => ({ registerDevice: jest.fn() }));

// Load a fresh copy of ../push under the given Platform.OS and hand back the
// setNotificationHandler spy that fresh copy called (or didn't). Platform is a RN
// singleton reset by resetModules/isolateModules, so we must set OS on the FRESH
// react-native the isolated push.ts will see — set it INSIDE the isolate, before
// requiring push.
function loadPushUnderOS(os: string): jest.Mock {
  let spy: jest.Mock = (() => {}) as unknown as jest.Mock;
  jest.isolateModules(() => {
    const { Platform } = require('react-native') as { Platform: { OS: string } };
    Platform.OS = os;
    require('../push');
    spy = (require('expo-notifications') as { setNotificationHandler: jest.Mock })
      .setNotificationHandler;
  });
  return spy;
}

beforeEach(() => {
  jest.resetModules();
});

describe('foreground handler web guard (WHIT-144)', () => {
  it('[A5] web: does NOT register the foreground notification handler', () => {
    const spy = loadPushUnderOS('web');
    expect(spy).not.toHaveBeenCalled();
  });

  it('[A6] native (ios): DOES register the handler — proves the guard, not a dead import', () => {
    const spy = loadPushUnderOS('ios');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('[A6b] native (android): also registers the handler', () => {
    const spy = loadPushUnderOS('android');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
