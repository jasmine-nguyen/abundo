// WHIT-145 — the push-token rotation listener (registerPushTokenRotation in src/push.ts).
// Expo tokens can rotate mid-session; without this, the server holds a stale token until
// the next launch. Two correctness traps are locked here:
//   1. the listener event carries the RAW DEVICE token, not the Expo token — we must
//      re-register the EXPO token from getExpoPushTokenAsync, never forward token.data;
//   2. re-deriving the Expo token must NOT re-trigger the listener (infinite loop) — we
//      pass the event's device token into getExpoPushTokenAsync so it skips its internal
//      getDevicePushTokenAsync. Both are fail-on-revert anchors below.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAddListener = jest.fn();
const mockGetToken = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-notifications', () => ({
  // setNotificationHandler runs at module scope on import (WHIT-144) — an inline
  // jest.fn() so it isn't undefined before the top-level spies below initialise.
  setNotificationHandler: jest.fn(),
  addPushTokenListener: (...a: unknown[]) => mockAddListener(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetToken(...a),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));

let mockProjectId: string | undefined = 'test-project';
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { get expoConfig() { return { extra: { eas: { projectId: mockProjectId } } }; } },
}));

const mockRegisterDevice = jest.fn();
jest.mock('../api', () => ({ registerDevice: (...a: unknown[]) => mockRegisterDevice(...a) }));

import { Platform } from 'react-native';
import { registerPushTokenRotation } from '../push';

// The listener body is a fire-and-forget async IIFE; let its awaited chain settle.
const flush = () => new Promise<void>((resolve) => { setImmediate(() => resolve()); });

// A raw device-token event (what addPushTokenListener actually delivers) — NOT the Expo token.
const DEVICE_EVENT = { type: 'ios', data: 'DevicePushToken[fcm-raw-xyz]' };

let capturedListener: ((token: unknown) => void) | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as unknown as { OS: string }).OS = 'ios';
  mockProjectId = 'test-project';
  capturedListener = undefined;
  mockAddListener.mockImplementation((cb: unknown) => {
    capturedListener = cb as (token: unknown) => void;
    return { remove: mockRemove };
  });
  (mockGetToken as jest.Mock).mockResolvedValue({ data: 'ExpoPushToken[new]' } as never);
  (mockRegisterDevice as jest.Mock).mockResolvedValue({ token: 'ExpoPushToken[new]' } as never);
});

it('installs the listener once on native and returns the subscription', () => {
  const sub = registerPushTokenRotation();
  expect(mockAddListener).toHaveBeenCalledTimes(1);
  expect(sub).toEqual({ remove: mockRemove });
});

it('re-registers the EXPO token on rotation — never the raw device token', async () => {
  registerPushTokenRotation();
  capturedListener!(DEVICE_EVENT);
  await flush();

  expect(mockRegisterDevice).toHaveBeenCalledWith('ExpoPushToken[new]');
  // Fail-on-revert: forwarding token.data would register the raw device token.
  expect(mockRegisterDevice).not.toHaveBeenCalledWith(DEVICE_EVENT.data);
});

it('passes the device token into getExpoPushTokenAsync and fires exactly once (no loop)', async () => {
  registerPushTokenRotation();
  capturedListener!(DEVICE_EVENT);
  await flush();

  // Passing devicePushToken short-circuits Expo's internal getDevicePushTokenAsync,
  // which would re-emit this event and infinite-loop. Assert the full object is passed.
  expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'test-project', devicePushToken: DEVICE_EVENT });
  // One rotation event → exactly one re-register (proves no recursion).
  expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
});

it('is a no-op on web: returns undefined and installs no listener', () => {
  (Platform as unknown as { OS: string }).OS = 'web';
  const sub = registerPushTokenRotation();
  expect(sub).toBeUndefined();
  expect(mockAddListener).not.toHaveBeenCalled();
});

it('never throws if installing the listener fails — returns undefined', () => {
  mockAddListener.mockImplementation(() => { throw new Error('native module unavailable'); });
  expect(() => registerPushTokenRotation()).not.toThrow();
  expect(registerPushTokenRotation()).toBeUndefined();
});

it('rotation with no projectId: no token fetch, no register, no throw', async () => {
  mockProjectId = undefined;
  registerPushTokenRotation();
  capturedListener!(DEVICE_EVENT);
  await flush();

  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});
