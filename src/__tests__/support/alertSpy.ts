// Shared confirm-pop-up helpers for screen tests. (Not a *.test file, so Jest never runs it as a suite.)
import { jest, beforeEach, afterEach, expect } from '@jest/globals';
import { Alert } from 'react-native';

type AlertButton = { text?: string; style?: string; onPress?: () => void | Promise<void> };

/** Fake Alert.alert for every test in the enclosing scope; restored after each test. */
export function spyOnAlert() {
  let spy: jest.SpiedFunction<typeof Alert.alert>;
  beforeEach(() => { spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); });
  return {
    get spy() { return spy; },
    last() {
      const [title, message, buttons = []] = spy.mock.calls[spy.mock.calls.length - 1] as [string, string | undefined, AlertButton[] | undefined];
      return { title, message, buttons, button: (text: string) => buttons.find((button) => button.text === text)! };
    },
  };
}

/** The one pop-up shown so far is the shared Cancel / Delete (red) confirm, with this title. */
export function expectConfirmDeletePopUp(alerts: ReturnType<typeof spyOnAlert>, title: string) {
  expect(alerts.spy).toHaveBeenCalledTimes(1);
  expect(alerts.last().title).toBe(title);
  expect(alerts.last().buttons.map((button) => [button.text, button.style])).toEqual([['Cancel', 'cancel'], ['Delete', 'destructive']]);
}

export function pressAlertButton(alerts: ReturnType<typeof spyOnAlert>, text: string) {
  return alerts.last().button(text).onPress?.();
}
