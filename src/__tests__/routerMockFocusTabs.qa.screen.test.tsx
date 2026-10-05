// WHIT-753 QA — the shared router stand-in through a real jest.mock + render, the way the converted
// suites use it: run-on-mount focus, fireFocus re-firing the latest callback, resetRouter dropping
// a stale callback, the do-nothing Tabs, and usePathname following setPathname.
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import React from 'react';
import { render, renderHook } from '@testing-library/react-native';
import { Tabs, useFocusEffect, usePathname } from 'expo-router';
import { fireFocus, resetRouter, setPathname } from './support/routerMock';

jest.mock('expo-router', () => require('./support/routerMock').routerMockModule());

beforeEach(() => resetRouter());

const focusHook = (callback: () => void) => renderHook(() => useFocusEffect(callback));

describe('WHIT-753 QA shared router stand-in, rendered', () => {
  // [A2]
  it('useFocusEffect runs the callback once on mount', () => {
    const onFocus = jest.fn();
    focusHook(onFocus);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  // [A3]
  it('fireFocus re-runs the callback the screen last passed to useFocusEffect', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => useFocusEffect(cb), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    first.mockClear();
    second.mockClear();

    fireFocus();

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  // [A4]
  it('resetRouter drops the stored focus callback, so an earlier screen cannot refocus later', () => {
    const onFocus = jest.fn();
    focusHook(onFocus);
    onFocus.mockClear();

    resetRouter();
    fireFocus();

    expect(onFocus).not.toHaveBeenCalled();
  });

  // [A5]
  it('Tabs with Tabs.Screen children renders nothing', () => {
    const { toJSON } = render(
      <Tabs>
        <Tabs.Screen name="budgets" />
      </Tabs>,
    );
    expect(toJSON()).toBeNull();
  });

  // [A6]
  it('usePathname is /budgets by default and follows setPathname inside a render', () => {
    expect(renderHook(() => usePathname()).result.current).toBe('/budgets');
    setPathname('/insights');
    expect(renderHook(() => usePathname()).result.current).toBe('/insights');
  });

  // [A7]
  it('resetRouter puts a changed path back before the next test', () => {
    setPathname('/goals');
    resetRouter();
    expect(renderHook(() => usePathname()).result.current).toBe('/budgets');
  });
});
