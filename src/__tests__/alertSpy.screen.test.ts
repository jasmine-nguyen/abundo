// WHIT-709 QA — the shared confirm-pop-up helper itself: a fresh fake per test, restored after
// its scope, reads the latest pop-up, and taps buttons by their label (loudly when one is missing).
import { describe, it, expect, jest } from '@jest/globals';
import { Alert } from 'react-native';
import { pressAlertButton, spyOnAlert } from './support/alertSpy';

describe('inside spyOnAlert scope', () => {
  const alerts = spyOnAlert();

  // [A1] call count from the previous test must not leak into this one
  it('first test shows one pop-up', () => {
    Alert.alert('One');
    expect(alerts.spy).toHaveBeenCalledTimes(1);
  });
  it('next test starts with a fresh fake', () => {
    expect(alerts.spy).toHaveBeenCalledTimes(0);
  });

  // [A2] last() reads the most recent pop-up; button() finds by label
  it('last() returns the latest pop-up and its buttons', () => {
    Alert.alert('Old', 'old msg', [{ text: 'Old' }]);
    Alert.alert('New', 'new msg', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive' }]);
    const last = alerts.last();
    expect(last.title).toBe('New');
    expect(last.message).toBe('new msg');
    expect(last.buttons).toHaveLength(2);
    expect(last.button('Delete').style).toBe('destructive');
    expect(last.button('Cancel').style).toBe('cancel');
  });

  // [A3] pressAlertButton taps only the named button and hands back its promise
  it('pressAlertButton presses the named button only', async () => {
    const onCancel = jest.fn();
    const onDelete = jest.fn(async () => 'done');
    Alert.alert('Delete?', undefined, [{ text: 'Cancel', onPress: onCancel }, { text: 'Delete', onPress: onDelete }]);
    await expect(pressAlertButton(alerts, 'Delete')).resolves.toBe('done');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  // [A4] a wrong label fails the test instead of silently tapping nothing
  it('pressAlertButton throws when no button has that label', () => {
    Alert.alert('Delete?', undefined, [{ text: 'Delete', onPress: () => {} }]);
    expect(() => pressAlertButton(alerts, 'Remove')).toThrow();
  });
});

// [A5] the real Alert.alert is put back once the helper's scope ends
describe('outside spyOnAlert scope', () => {
  it('Alert.alert is no longer faked', () => {
    expect(jest.isMockFunction(Alert.alert)).toBe(false);
  });
});
