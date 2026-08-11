// Tests the launch-time push registration flow (src/push.ts): permission gate,
// token fetch, and best-effort no-crash behaviour. expo-notifications, expo-
// constants and ../api are mocked, so nothing native/network runs. Runs in the
// `screen` project (needs the react-native env for Platform); push.ts renders
// nothing, so the flow is driven by calling it directly, not by mounting.
//
// WHIT-459 — consolidated push-notification screen cluster. This file is the single
// survivor of six; the folded siblings (handler / rotation / rotation-edges /
// webguard / edges) are appended below under `// ===== ` headers, each preserving
// its it bodies byte-for-byte. The module-scope expo-notifications mock is the
// SUPERSET of all six factories (addPushTokenListener added for the rotation folds);
// every added export is inert on the paths that never had it.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetToken = jest.fn();
const mockAddListener = jest.fn();
const mockRemove = jest.fn();
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: (...a: unknown[]) => mockGetPermissions(...a),
  requestPermissionsAsync: (...a: unknown[]) => mockRequestPermissions(...a),
  getExpoPushTokenAsync: (...a: unknown[]) => mockGetToken(...a),
  // addPushTokenListener is only exercised by the folded rotation blocks (WHIT-145);
  // registerForPushNotificationsAsync and the module-scope handler never call it, so
  // it is inert for the launch-flow / handler / webguard tests.
  addPushTokenListener: (...a: unknown[]) => mockAddListener(...a),
  // Called once at module scope (the WHIT-144 foreground handler); stub it so the
  // import doesn't hit undefined. Asserted in the folded handler block below.
  setNotificationHandler: jest.fn(),
}));

let mockProjectId: string | undefined = 'test-project';
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { get expoConfig() { return { extra: { eas: { projectId: mockProjectId } } }; } },
}));

const mockRegisterDevice = jest.fn();
jest.mock('../api', () => ({ registerDevice: (...a: unknown[]) => mockRegisterDevice(...a) }));

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerForPushNotificationsAsync, registerPushTokenRotation } from '../push';

// The foreground handler fires as a module-scope side effect the instant '../push' is
// imported, before any beforeEach — so snapshot the call count and the handler arg NOW.
// The outer beforeEach's jest.clearAllMocks() wipes the live mock's call log, but these
// module-scope consts already hold the captured values/reference (folded from
// push.handler.screen.test.tsx, WHIT-144).
const mockSetHandler = Notifications.setNotificationHandler as jest.Mock;
const setHandlerCallCount = mockSetHandler.mock.calls.length;
const registeredHandler = mockSetHandler.mock.calls[0]?.[0] as
  | { handleNotification: () => Promise<Record<string, unknown>> }
  | undefined;

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

// ===== WHIT-459 (folded from push.edges.screen.test.tsx) — adversarial gaps for the
// launch push flow. Mocks/beforeEach are byte-identical to this survivor's, so these
// run as top-level its under the shared setup above (no per-block fixture needed).
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

// ===== WHIT-144 (folded from push.handler.screen.test.tsx) — the foreground handler
// registered at module scope. Fires ONCE on import, before any beforeEach; the
// snapshot consts (setHandlerCallCount / registeredHandler) captured at file load hold
// the recorded call, so the outer beforeEach's clearAllMocks can't wipe them.
describe('foreground notification handler (WHIT-144)', () => {
  it('registers exactly one notification handler at launch', () => {
    expect(setHandlerCallCount).toBe(1);
    expect(registeredHandler).toBeDefined();
    expect(typeof registeredHandler!.handleNotification).toBe('function');
  });

  it('presents a foreground push as quiet-but-visible, in the non-deprecated shape', async () => {
    const behaviour = await registeredHandler!.handleNotification();
    // Banner + notification-centre list, but no sound and no badge.
    expect(behaviour).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    // The deprecated field must NOT be used — on expo-notifications@56 it omits the
    // two required fields and logs a deprecation warning.
    expect(behaviour).not.toHaveProperty('shouldShowAlert');
  });
});

// ===== WHIT-145 — the push-token rotation listener (registerPushTokenRotation).
// The rotation folds share a byte-identical fixture (flush / capturedListener /
// beforeEach), so it lives once on this child describe; each sibling's DEVICE consts
// and its blocks sit under their own header inside it. This block-scoped beforeEach
// runs AFTER the outer one, re-seeding the shared mutable mocks for the rotation path.
describe('push-token rotation (WHIT-145)', () => {
  // The listener body is a fire-and-forget async IIFE; let its awaited chain settle.
  const flush = () => new Promise<void>((resolve) => { setImmediate(() => resolve()); });

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

  // ===== WHIT-145 (folded from push.rotation.screen.test.tsx)
  // A raw device-token event (what addPushTokenListener actually delivers) — NOT the Expo token.
  const DEVICE_EVENT = { type: 'ios', data: 'DevicePushToken[fcm-raw-xyz]' };

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

  // ===== WHIT-145 (folded from push.rotation.edges.screen.test.tsx)
  const DEVICE_A = { type: 'ios', data: 'DevicePushToken[A]' };
  const DEVICE_B = { type: 'ios', data: 'DevicePushToken[B]' };

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
});

// ===== WHIT-144 (folded from push.webguard.screen.test.tsx) — [A5][A6] the web guard
// on the foreground handler. Re-evaluates push.ts fresh under a chosen Platform.OS via
// jest.isolateModules(+resetModules), minting a fresh setNotificationHandler spy each
// time. Self-contained: its own beforeEach + loadPushUnderOS helper, block-scoped.
describe('foreground handler web guard (WHIT-144)', () => {
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
