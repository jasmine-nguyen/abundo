// WHIT-145 — adversarial gaps for the push-token rotation listener (registerPushTokenRotation
// in src/push.ts). The implementer's push.rotation.screen.test.tsx already locks: install-once,
// EXPO-token-not-device-token, loop-prevention (devicePushToken passed + one register), web
// no-op, install-fails-never-throws, and no-projectId. This file adds the ROTATION-branch paths
// they left open, all under the same "best-effort, never throws into launch" contract:
//   - [B1] two rotations in a row -> two independent re-registers (no shared-state interference)
//   - [B2] getExpoPushTokenAsync REJECTS inside the callback (offline mid-rotation) -> no register
//   - [B3] empty-string Expo token in the rotation path -> the shared `if (!token) return` guard
//          skips registerDevice on the rotation branch too (push.edges only proved it one-shot)
//   - [B4] registerDevice REJECTS inside the callback -> swallowed, never surfaces
// Mocks mirror push.rotation.screen.test.tsx exactly so the real production code runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAddListener = jest.fn();
const mockGetToken = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-notifications', () => ({
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

const DEVICE_A = { type: 'ios', data: 'DevicePushToken[A]' };
const DEVICE_B = { type: 'ios', data: 'DevicePushToken[B]' };

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

it('[B1] two rotations in a row -> two independent re-registers, each keyed to its own device token', async () => {
  // Distinct Expo tokens per device token so we prove neither call clobbers the other's state.
  (mockGetToken as jest.Mock).mockImplementation((opts: unknown) => {
    const dev = (opts as { devicePushToken?: { data?: string } }).devicePushToken?.data;
    return Promise.resolve({ data: dev === DEVICE_A.data ? 'ExpoPushToken[A]' : 'ExpoPushToken[B]' });
  });

  registerPushTokenRotation();
  capturedListener!(DEVICE_A);
  capturedListener!(DEVICE_B);
  await flush();

  expect(mockGetToken).toHaveBeenNthCalledWith(1, { projectId: 'test-project', devicePushToken: DEVICE_A });
  expect(mockGetToken).toHaveBeenNthCalledWith(2, { projectId: 'test-project', devicePushToken: DEVICE_B });
  expect(mockRegisterDevice).toHaveBeenCalledTimes(2);
  expect(mockRegisterDevice).toHaveBeenCalledWith('ExpoPushToken[A]');
  expect(mockRegisterDevice).toHaveBeenCalledWith('ExpoPushToken[B]');
});

it('[B2] getExpoPushTokenAsync rejects mid-rotation (offline): no register, listener never throws', async () => {
  (mockGetToken as jest.Mock).mockRejectedValue(new Error('offline') as never);

  registerPushTokenRotation();
  expect(() => capturedListener!(DEVICE_A)).not.toThrow(); // sync callback must not throw
  await flush();

  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('[B3] empty Expo token in the rotation path: shared guard skips registerDevice', async () => {
  // getExpoPushTokenAsync resolves but data is '' — fetchAndRegisterExpoToken's `if (!token) return`
  // must fire on the ROTATION branch too, so no blank token is POSTed.
  (mockGetToken as jest.Mock).mockResolvedValue({ data: '' } as never);

  registerPushTokenRotation();
  capturedListener!(DEVICE_A);
  await flush();

  expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'test-project', devicePushToken: DEVICE_A });
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('[B4] registerDevice rejects inside the callback: swallowed, listener never throws', async () => {
  (mockRegisterDevice as jest.Mock).mockRejectedValue(new Error('server 500') as never);

  registerPushTokenRotation();
  expect(() => capturedListener!(DEVICE_A)).not.toThrow();
  await flush();

  // It was attempted once (the failure is swallowed, not retried/looped).
  expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
});
