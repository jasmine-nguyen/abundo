// WHIT-753 — the shared router stand-in also covers the tab bar and the current page path, so
// tab-bar and pathname suites don't each copy their own stub.
import { describe, it, expect, beforeEach } from '@jest/globals';
import * as routerMock from './routerMock';

const { resetRouter, routerMockModule } = routerMock;
const setPathname = (routerMock as unknown as { setPathname: (next: string) => void }).setPathname;

type TabsStub = (() => unknown) & { Screen: () => unknown };
type WithTabsAndPath = { Tabs: TabsStub; usePathname: () => string };
const sharedModule = () => routerMockModule() as unknown as WithTabsAndPath;

beforeEach(() => resetRouter());

describe('WHIT-753 routerMock tab bar + current page', () => {
  it('Tabs and Tabs.Screen render nothing', () => {
    const { Tabs } = sharedModule();
    expect(Tabs()).toBeNull();
    expect(Tabs.Screen()).toBeNull();
  });

  it('usePathname defaults to /budgets and follows setPathname', () => {
    const mod = sharedModule();
    expect(mod.usePathname()).toBe('/budgets');
    setPathname('/insights');
    expect(mod.usePathname()).toBe('/insights');
  });

  it('resetRouter puts the path back to /budgets', () => {
    const mod = sharedModule();
    setPathname('/settings');
    resetRouter();
    expect(mod.usePathname()).toBe('/budgets');
  });
});
