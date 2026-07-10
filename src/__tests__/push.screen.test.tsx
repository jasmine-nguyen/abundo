// Tests the launch-time push registration flow (src/push.ts): permission gate,
// token fetch, and best-effort no-crash behaviour. expo-notifications, expo-
// constants and ../api are mocked, so nothing native/network runs. Runs in the
// `screen` project (needs the react-native env for Platform); push.ts renders
// nothing, so the flow is driven by calling it directly, not by mounting.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetToken = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetToken(...a),
  // Called once at module scope (the WHIT-144 foreground handler); stub it so the
  // import doesn't hit undefined. Asserted in push.handler.screen.test.tsx.
  setNotificationHandler: jest.fn(),
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

it('fresh grant: requests permission, fetches the token, registers it', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'undetermined', canAskAgain: true } as never);
  (mockRequestPermissions as jest.Mock).mockResolvedValue({ status: 'granted' } as never);
  (mockGetToken as jest.Mock).mockResolvedValue({ data: 'ExpoPushToken[abc]' } as never);

  await registerForPushNotificationsAsync();

  expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
  expect(mockGetToken).toHaveBeenCalledWith({ projectId: 'test-project' });
  expect(mockRegisterDevice).toHaveBeenCalledWith('ExpoPushToken[abc]');
});

it('already granted: does NOT re-prompt, still registers', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false } as never);
  (mockGetToken as jest.Mock).mockResolvedValue({ data: 'ExpoPushToken[abc]' } as never);

  await registerForPushNotificationsAsync();

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockRegisterDevice).toHaveBeenCalledWith('ExpoPushToken[abc]');
});

it('hard denial (canAskAgain false): no prompt, no token, no register, no throw', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'denied', canAskAgain: false } as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();

  expect(mockRequestPermissions).not.toHaveBeenCalled();
  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('user denies the prompt: does NOT register', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'undetermined', canAskAgain: true } as never);
  (mockRequestPermissions as jest.Mock).mockResolvedValue({ status: 'denied' } as never);

  await registerForPushNotificationsAsync();

  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('missing projectId: bails before fetching a token', async () => {
  mockProjectId = undefined;
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false } as never);

  await registerForPushNotificationsAsync();

  expect(mockGetToken).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('token fetch rejects (simulator): swallowed, no register, no throw', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false } as never);
  (mockGetToken as jest.Mock).mockRejectedValue(new Error('no device') as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});

it('registerDevice rejects (offline): swallowed, no throw', async () => {
  (mockGetPermissions as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false } as never);
  (mockGetToken as jest.Mock).mockResolvedValue({ data: 'ExpoPushToken[abc]' } as never);
  (mockRegisterDevice as jest.Mock).mockRejectedValue(new Error('offline') as never);

  await expect(registerForPushNotificationsAsync()).resolves.toBeUndefined();
});

it('web: no-op — never touches the native permission API', async () => {
  (Platform as unknown as { OS: string }).OS = 'web';

  await registerForPushNotificationsAsync();

  expect(mockGetPermissions).not.toHaveBeenCalled();
  expect(mockRegisterDevice).not.toHaveBeenCalled();
});
