// Stand-ins for the root layout's launch side effects and app-wide providers, one module factory
// each, so a suite that mounts app/_layout stays hermetic:
//
//   jest.mock('expo-status-bar', () => require('./support/rootLayoutMock').statusBarMock());
import React from 'react';

const passthrough = ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children);
const nothing = () => null;

export const pushMock = () => ({
  registerForPushNotificationsAsync: () => {},
  registerPushTokenRotation: () => ({ remove: () => {} }),
});
export const interFontsMock = (loaded: () => boolean) => ({
  useFonts: () => [loaded()],
  Inter_500Medium: 'Inter_500Medium',
  Inter_700Bold: 'Inter_700Bold',
});
export const interTightFontsMock = () => ({ InterTight_800ExtraBold: 'InterTight_800ExtraBold' });
export const splashScreenMock = () => ({
  preventAutoHideAsync: () => Promise.resolve(),
  hideAsync: () => Promise.resolve(),
});
export const statusBarMock = () => ({ StatusBar: nothing });
// AppProvider fires data fetches on mount.
export const appProviderMock = () => ({ AppProvider: passthrough });
export const overlaysMock = () => ({ Overlays: nothing });
// NotificationRouter imports expo-notifications, a native module; covered by notificationRouter.screen.test.tsx.
export const notificationRouterMock = () => ({ NotificationRouter: nothing });
