// Shared confirm-pop-up helpers for screen tests. (Not a *.test file, so Jest never runs it as a suite.)
import { jest, beforeEach, afterEach } from '@jest/globals';
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

export function pressAlertButton(alerts: ReturnType<typeof spyOnAlert>, text: string) {
  return alerts.last().button(text).onPress?.();
}
