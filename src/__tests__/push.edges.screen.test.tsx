// Adversarial gaps for the launch push flow (src/push.ts). The implementer's
// push.screen.test.tsx already locks: fresh-grant, already-granted, hard-denial,
// prompt-then-deny, missing projectId, token-fetch-rejects, registerDevice-rejects,
// and web no-op. This file adds the paths they missed, all asserting the same
// "best-effort, never throws into launch" contract:
//   - getPermissionsAsync itself REJECTS (not just the token fetch)
//   - requestPermissionsAsync REJECTS mid-prompt
//   - a permissions object with canAskAgain UNDEFINED (status undetermined)
//   - an empty-string token from getExpoPushTokenAsync (currently UNGUARDED)
// Mocks mirror push.screen.test.tsx exactly so the real production function runs.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetToken = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetToken(...a),
}));

let mockProjectId: string | undefined = 'test-project';
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { get expoConfig() { return { extra: { eas: { projectId: mockProjectId } } }; } },
}));

const mockRegisterDevice = jest.fn();
jest.mock('../api', () => ({ registerDevice: (...a: unknown[]) => mockRegisterDevice(...a) }));

import { Platform } from 'react-native';
import { registerForPushNotificationsAsync } from '../push';

beforeEach(() => {
  jest.clearAllMocks();
  (Platform as unknown as { OS: string }).OS = 'ios';
  mockProjectId = 'test-project';
  (mockRegisterDevice as jest.Mock).mockResolvedValue({ token: 'ExpoPushToken[abc]' } as never);
});

it('getPermissionsAsync itself rejects: swallowed, no request/token/register, no throw', async () => {
  (mockGetPermissions as jest.Mock).mockRejectedValue(new Error('native module unavailable') as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('requestPermissionsAsync rejects mid-prompt: swallowed, no token/register, no throw', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'undetermined', canAskAgain: true } as never);
  (mockRequestPermissions as jest.Mock).mockRejectedValue(new Error('prompt failed') as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();

  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('permissions missing canAskAgain (undetermined): bails without prompting or crashing', async () => {
  // canAskAgain === undefined => `status !== 'granted' && undefined` is falsy, so the
  // request is skipped; status stays undetermined, so the function returns cleanly.
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'undetermined' } as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('empty-string token: guarded — does NOT POST a blank token', async () => {
  // getExpoPushTokenAsync resolved but data is '' — push.ts guards it, so
  // registerDevice is never called with an empty token (no wasted 400 round-trip).
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false } as never);
  (mockGetToken as jest.Mock).mockResolvedValue({ data: '' } as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();

  expect(mockRegisterDevice).not.toHaveBeenCalled();
});
